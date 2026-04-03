import type { MetabaseEnv } from "./metabase-server.js";

/** Worker `env` bindings (wrangler vars + secrets + resources). */
export interface CloudflareWorkerEnv extends MetabaseEnv {
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  /** Optional comma-separated list of allowed Google emails (lowercase matching). */
  GOOGLE_ALLOWED_EMAILS?: string;
}
