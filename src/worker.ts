/**
 * Metabase MCP on Cloudflare: Google OAuth + Streamable HTTP MCP (McpAgent).
 * @see https://developers.cloudflare.com/agents/guides/remote-mcp-server/#third-party-oauth
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpAgent } from "agents/mcp";
import type { CloudflareWorkerEnv } from "./cloudflare-bindings.js";
export type { CloudflareWorkerEnv as Env } from "./cloudflare-bindings.js";
import type { GoogleUserProps } from "./google-handler.js";
import { GoogleHandler } from "./google-handler.js";
import { MetabaseServer } from "./metabase-server.js";

type CloudflareExportedHandler<E> = {
  fetch: (request: Request, env: E, ctx: ExecutionContext) => Response | Promise<Response>;
};

export class MetabaseMcp extends McpAgent<CloudflareWorkerEnv, unknown, GoogleUserProps> {
  private metabase?: MetabaseServer;

  get server(): Server {
    if (!this.metabase) {
      this.metabase = new MetabaseServer({
        METABASE_URL: this.env.METABASE_URL,
        METABASE_API_KEY: this.env.METABASE_API_KEY,
        METABASE_USERNAME: this.env.METABASE_USERNAME,
        METABASE_PASSWORD: this.env.METABASE_PASSWORD,
      });
    }
    return this.metabase.getMcpServer();
  }

  async init(): Promise<void> {
    // Tools/resources registered in MetabaseServer; Google identity is available on this.props after OAuth.
  }
}

export default new OAuthProvider({
  apiHandler: MetabaseMcp.serve("/mcp", { binding: "MCP_OBJECT" }),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GoogleHandler as unknown as CloudflareExportedHandler<CloudflareWorkerEnv>,
  tokenEndpoint: "/token",
});
