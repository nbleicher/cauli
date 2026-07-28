import { createServer } from "node:http";
import {
  backUpOneSourceAudio,
  loadActiveBackupRecipients,
  reportBackupLag,
} from "./backup.js";
import { backupTargetFromEnvironment } from "./backup-target.js";
import { config } from "./config.js";
import { claimJob, cleanupAbandonedCalls, runJob } from "./jobs.js";
import { log, sanitizedError } from "./log.js";
import { downloadStorageBuffer } from "./storage.js";

let shuttingDown = false;
let activeJobs = 0;
let lastCleanupAt = 0;
let lastLagReportAt = 0;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Source Audio Backup runs on its own loop rather than inside the processing
 * job, so a slow or unreachable VPS delays only the recovery copy and never a
 * Call reaching Ready.
 */
async function backupLoop() {
  const target = backupTargetFromEnvironment();
  if (!target) {
    // Loudly, and once: a Workspace whose Source Audio is not being copied
    // anywhere should not look healthy.
    log.error("source_audio_backup_not_configured", {});
    return;
  }

  while (!shuttingDown) {
    try {
      if (Date.now() - lastLagReportAt > 60_000) {
        lastLagReportAt = Date.now();
        await reportBackupLag();
      }
      const recipients = await loadActiveBackupRecipients();
      if (!recipients) {
        log.error("source_audio_backup_has_no_key_version", {});
        await delay(60_000);
        continue;
      }
      const worked = await backUpOneSourceAudio({
        downloadSourceAudio: downloadStorageBuffer,
        target,
        recipients,
      });
      if (!worked) await delay(config.pollMs);
    } catch (error) {
      log.error("source_audio_backup_loop_error", {
        error: sanitizedError(error),
      });
      await delay(config.pollMs);
    }
  }
}

async function workerLoop(index: number) {
  while (!shuttingDown) {
    try {
      if (Date.now() - lastCleanupAt > 24 * 60 * 60 * 1_000) {
        lastCleanupAt = Date.now();
        await cleanupAbandonedCalls();
      }
      const job = await claimJob();
      if (!job) {
        await delay(config.pollMs);
        continue;
      }
      activeJobs += 1;
      await runJob(job);
      activeJobs -= 1;
    } catch (error) {
      activeJobs = Math.max(0, activeJobs - 1);
      log.error("worker_loop_error", {
        workerIndex: index,
        error: sanitizedError(error),
      });
      await delay(config.pollMs);
    }
  }
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(shuttingDown ? 503 : 200, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify({
        ok: !shuttingDown,
        worker: config.workerName,
        activeJobs,
      })
    );
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(config.port, () => {
  log.info("worker_started", {
    worker: config.workerName,
    concurrency: config.concurrency,
    port: config.port,
  });
});

for (let index = 0; index < config.concurrency; index += 1) {
  void workerLoop(index);
}
void backupLoop();

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("worker_stopping", { signal, activeJobs });
  server.close();
  const deadline = Date.now() + 30_000;
  while (activeJobs > 0 && Date.now() < deadline) await delay(250);
  process.exit(activeJobs > 0 ? 1 : 0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
