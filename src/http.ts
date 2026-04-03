#!/usr/bin/env node

/**
 * Streamable HTTP MCP endpoint for remote clients (MCP Inspector, tunneling, etc.).
 * Endpoint: POST/GET/DELETE {MCP_HTTP_PATH} (default /mcp)
 *
 * Env:
 *   MCP_HTTP_HOST (default 0.0.0.0)
 *   MCP_HTTP_PORT (default 8787)
 *   MCP_HTTP_PATH (default /mcp)
 *   MCP_HTTP_ALLOWED_HOSTS — comma-separated Host header allowlist for DNS rebinding protection
 *     (set to your tunnel hostname, e.g. "abc.trycloudflare.com" or leave unset behind a trusted proxy)
 */

import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import { MetabaseServer } from "./metabase-server.js";

const MCP_HTTP_HOST = process.env.MCP_HTTP_HOST ?? "0.0.0.0";
const MCP_HTTP_PORT = parseInt(process.env.MCP_HTTP_PORT ?? "8787", 10);
const MCP_HTTP_PATH = process.env.MCP_HTTP_PATH ?? "/mcp";

const allowedHostsEnv = process.env.MCP_HTTP_ALLOWED_HOSTS?.trim();
const allowedHosts = allowedHostsEnv
  ? allowedHostsEnv.split(",").map((h) => h.trim()).filter(Boolean)
  : undefined;

process.on("uncaughtException", (error: Error) => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "fatal",
      message: "Uncaught Exception",
      error: error.message,
      stack: error.stack,
    })
  );
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "fatal",
      message: "Unhandled Rejection",
      error: errorMessage,
    })
  );
});

const transports: Record<string, StreamableHTTPServerTransport> = {};

const app = createMcpExpressApp({
  host: MCP_HTTP_HOST,
  ...(allowedHosts ? { allowedHosts } : {}),
});

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ ok: true, service: "metabase-mcp-http" });
});

const mcpPostHandler = async (req: Request, res: Response): Promise<void> => {
  const sessionIdHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const eventStore = new InMemoryEventStore();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore,
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
        }
      };

      const metabase = new MetabaseServer();
      await metabase.connectHttpTransport(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
};

const mcpGetHandler = async (req: Request, res: Response): Promise<void> => {
  const sessionIdHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

const mcpDeleteHandler = async (req: Request, res: Response): Promise<void> => {
  const sessionIdHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

app.post(MCP_HTTP_PATH, mcpPostHandler);
app.get(MCP_HTTP_PATH, mcpGetHandler);
app.delete(MCP_HTTP_PATH, mcpDeleteHandler);

const httpServer = app.listen(MCP_HTTP_PORT, MCP_HTTP_HOST, () => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      message: `Metabase MCP Streamable HTTP on http://${MCP_HTTP_HOST}:${MCP_HTTP_PORT}${MCP_HTTP_PATH}`,
    })
  );
});

process.on("SIGINT", async () => {
  for (const sid of Object.keys(transports)) {
    try {
      await transports[sid]?.close();
      delete transports[sid];
    } catch (e) {
      console.error(`Error closing transport ${sid}:`, e);
    }
  }
  httpServer.close(() => process.exit(0));
});
