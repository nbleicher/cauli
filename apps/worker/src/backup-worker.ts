#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js";
import { createServer } from "node:http";
import {
  backUpOneSourceAudio,
  loadActiveBackupRecipients,
  reportBackupLag,
} from "./backup.js";
import { backupTargetFromEnvironment } from "./backup-target.js";
import { log, sanitizedError } from "./log.js";
import { downloadStorageBufferWithClient } from "./storage.js";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const pollMs = Number(process.env.BACKUP_POLL_MS ?? 2_000);
const workerName =
  process.env.RAILWAY_REPLICA_ID ??
  `backup-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const client = createClient(
  required("SUPABASE_URL"),
  required("SUPABASE_BACKUP_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const target = backupTargetFromEnvironment();
let stopping = false;
let lastLagReportAt = 0;
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(stopping ? 503 : 200).end();
    return;
  }
  response.writeHead(404).end();
});
server.listen(Number(process.env.PORT ?? 8_080));

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function run() {
  if (!target) throw new Error("Source Audio Backup target is not configured");
  while (!stopping) {
    try {
      if (Date.now() - lastLagReportAt > 60_000) {
        lastLagReportAt = Date.now();
        await reportBackupLag(client);
      }
      const recipients = await loadActiveBackupRecipients(
        client,
        required("BACKUP_KMS_PUBLIC_KEY")
      );
      if (!recipients) {
        log.error("source_audio_backup_has_no_key_version", {});
        await delay(60_000);
        continue;
      }
      const worked = await backUpOneSourceAudio({
        client,
        workerName,
        downloadSourceAudio: (path) =>
          downloadStorageBufferWithClient(client, path),
        target,
        recipients,
      });
      if (!worked) await delay(pollMs);
    } catch (error) {
      log.error("source_audio_backup_loop_error", {
        error: sanitizedError(error),
      });
      await delay(pollMs);
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
