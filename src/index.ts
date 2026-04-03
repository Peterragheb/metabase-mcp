#!/usr/bin/env node

import { MetabaseServer } from "./metabase-server.js";

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

const server = new MetabaseServer();
server.run().catch(console.error);
