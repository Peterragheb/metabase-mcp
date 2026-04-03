/**
 * Google OAuth UI flow for MCP (authorize + callback).
 * Pattern matches Cloudflare's GitHub OAuth demo; token/userinfo use Google's endpoints.
 * @see https://developers.cloudflare.com/agents/guides/remote-mcp-server/#third-party-oauth
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { CloudflareWorkerEnv } from "./cloudflare-bindings.js";
import { getUpstreamAuthorizeUrl } from "./oauth-upstream-utils.js";
import {
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils.js";

export type GoogleUserProps = {
  sub: string;
  email: string;
  name: string;
  picture?: string;
};

type EnvWithOAuth = CloudflareWorkerEnv & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: EnvWithOAuth }>();

app.get("/health", (c) =>
  c.json({ ok: true, service: "metabase-mcp-worker", auth: "google-oauth" }),
);

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;
  if (!clientId) {
    return c.text("Invalid request", 400);
  }

  if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
    return redirectToGoogle(c.req.raw, stateToken, c.env.GOOGLE_CLIENT_ID, sessionBindingCookie);
  }

  const { token: csrfToken, setCookie } = generateCSRFProtection();

  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    csrfToken,
    server: {
      description: "Metabase MCP — sign in with Google to use tools against your Metabase instance.",
      logo: "https://www.gstatic.com/images/branding/product/1x/googleg_48dp.png",
      name: "Metabase MCP (Google)",
    },
    setCookie,
    state: { oauthReqInfo },
  });
});

app.post("/authorize", async (c) => {
  try {
    const formData = await c.req.raw.formData();
    validateCSRFToken(formData, c.req.raw);

    const encodedState = formData.get("state");
    if (!encodedState || typeof encodedState !== "string") {
      return c.text("Missing state in form data", 400);
    }

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState));
    } catch {
      return c.text("Invalid state data", 400);
    }

    if (!state.oauthReqInfo?.clientId) {
      return c.text("Invalid request", 400);
    }

    const approvedClientCookie = await addApprovedClient(
      c.req.raw,
      state.oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY,
    );

    const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

    const headers = new Headers();
    headers.append("Set-Cookie", approvedClientCookie);
    headers.append("Set-Cookie", sessionBindingCookie);
    return redirectToGoogleWithHeaders(c.req.raw, stateToken, c.env.GOOGLE_CLIENT_ID, headers);
  } catch (error: unknown) {
    console.error("POST /authorize error:", error);
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    const msg = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Internal server error: ${msg}`, 500);
  }
});

function redirectToGoogle(
  request: Request,
  stateToken: string,
  clientId: string,
  setCookie: string,
): Response {
  const h = new Headers();
  h.set("Set-Cookie", setCookie);
  return redirectToGoogleWithHeaders(request, stateToken, clientId, h);
}

function redirectToGoogleWithHeaders(
  request: Request,
  stateToken: string,
  clientId: string,
  headers: Headers,
): Response {
  headers.set(
    "Location",
    getUpstreamAuthorizeUrl({
      client_id: clientId,
      redirect_uri: new URL("/callback", request.url).href,
      scope: "openid email profile",
      state: stateToken,
      upstream_url: "https://accounts.google.com/o/oauth2/v2/auth",
    }),
  );
  return new Response(null, { status: 302, headers });
}

async function exchangeGoogleCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<[string, null] | [null, Response]> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!resp.ok) {
    const t = await resp.text();
    console.error("Google token endpoint error:", t);
    return [null, new Response("Failed to exchange Google OAuth code", { status: 502 })];
  }
  const json = (await resp.json()) as { access_token?: string; error?: string };
  if (!json.access_token) {
    return [null, new Response(json.error ?? "Missing access_token from Google", { status: 400 })];
  }
  return [json.access_token, null];
}

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserProps | null> {
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) {
    return null;
  }
  const d = (await r.json()) as {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  };
  if (!d.sub || !d.email) {
    return null;
  }
  return {
    email: d.email,
    name: d.name ?? d.email,
    picture: d.picture,
    sub: d.sub,
  };
}

app.get("/callback", async (c) => {
  let oauthReqInfo: AuthRequest;
  let clearSessionCookie: string;

  try {
    const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
    oauthReqInfo = result.oauthReqInfo;
    clearSessionCookie = result.clearCookie;
  } catch (error: unknown) {
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    return c.text("Internal server error", 500);
  }

  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request data", 400);
  }

  const code = c.req.query("code");
  const redirectUri = new URL("/callback", c.req.url).href;
  const [accessToken, errResponse] = await exchangeGoogleCode(
    c.env.GOOGLE_CLIENT_ID,
    c.env.GOOGLE_CLIENT_SECRET,
    code ?? "",
    redirectUri,
  );
  if (errResponse) {
    return errResponse;
  }

  const user = await fetchGoogleUserInfo(accessToken);
  if (!user) {
    return c.text("Failed to load Google profile", 502);
  }

  const allowlist = c.env.GOOGLE_ALLOWED_EMAILS?.trim();
  if (allowlist) {
    const allowed = new Set(
      allowlist
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    );
    if (!allowed.has(user.email.toLowerCase())) {
      return c.text("Your Google account is not authorized for this MCP server.", 403);
    }
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    metadata: { label: user.name },
    props: {
      email: user.email,
      name: user.name,
      picture: user.picture,
      sub: user.sub,
    } satisfies GoogleUserProps,
    request: oauthReqInfo,
    scope: oauthReqInfo.scope,
    userId: user.sub,
  });

  const headers = new Headers({ Location: redirectTo });
  if (clearSessionCookie) {
    headers.set("Set-Cookie", clearSessionCookie);
  }

  return new Response(null, { status: 302, headers });
});

export { app as GoogleHandler };
