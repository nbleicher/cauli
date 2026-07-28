#!/usr/bin/env node
import { createServer } from "node:http";
import { log, sanitizedError } from "./log.js";
import {
  deleteOneAuthorizedBackup,
  retentionClientFromEnvironment,
  retentionTargetFromEnvironment,
} from "./retention.js";

const target = retentionTargetFromEnvironment();
const client = retentionClientFromEnvironment();
let stopping = false;
const workerName =
  process.env.RAILWAY_REPLICA_ID ??
  `retention-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(stopping ? 503 : 200).end();
    return;
  }
  response.writeHead(404).end();
});
server.listen(Number(process.env.PORT ?? 8_080));

async function run() {
  if (!target || !client) {
    throw new Error("The backup retention principal is not configured");
  }
  while (!stopping) {
    try {
      const worked = await deleteOneAuthorizedBackup({
        target,
        client,
        workerName,
      });
      if (!worked) await delay(60_000);
    } catch (error) {
      log.error("retention_loop_error", { error: sanitizedError(error) });
      await delay(60_000);
    }
  }
}

process.on("SIGTERM", () => {
  stopping = true;
  server.close();
});
process.on("SIGINT", () => {
  stopping = true;
  server.close();
});

void run();
