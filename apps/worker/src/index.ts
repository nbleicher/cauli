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
import {
  deleteOneAuthorizedBackup,
  expireCallsForRetention,
  reportBackupDeletionBacklog,
  retentionClientFromEnvironment,
  retentionTargetFromEnvironment,
} from "./retention.js";
import { downloadStorageBuffer } from "./storage.js";

let shuttingDown = false;
let activeJobs = 0;
let lastCleanupAt = 0;
let lastLagReportAt = 0;
let lastExpiryAt = 0;

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

  while (!shuttingDown) {
    try {
      // Lag is reported whether or not a target is configured. An unconfigured
      // backup is the loudest possible reason for a copy to be late, so this
      // must not be the branch that switches its own alarm off.
      if (Date.now() - lastLagReportAt > 60_000) {
        lastLagReportAt = Date.now();
        await reportBackupLag();
      }
      if (!target) {
        log.error("source_audio_backup_not_configured", {});
        await delay(60_000);
        continue;
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

/**
 * Retention runs as two separate authorities on purpose. Deciding that a Call
 * has expired is the application's, and carrying the removal out on the VPS is
 * the retention principal's, which holds a different database role and a
 * different client certificate.
 */
async function retentionLoop() {
  const target = retentionTargetFromEnvironment();
  const client = retentionClientFromEnvironment() ?? undefined;

  while (!shuttingDown) {
    try {
      // How much deletion the application has promised and nobody has carried
      // out. Reported first, and unconditionally, because the case where it
      // grows fastest is the case where the retention principal is missing.
      await reportBackupDeletionBacklog();

      if (!target || !client) {
        // Expiring a Call while the only principal that can remove its backup
        // is absent would tell the Workspace its recording is gone while the
        // encrypted copy stays on the VPS. Refuse rather than promise that.
        log.error("backup_retention_principal_not_configured", {});
        await delay(60_000);
        continue;
      }

      // Expiry is a sweep over every Call, so it runs on its own slow clock
      // rather than once per queued deletion.
      if (Date.now() - lastExpiryAt > 60_000) {
        lastExpiryAt = Date.now();
        await expireCallsForRetention();
      }

      const worked = await deleteOneAuthorizedBackup({ target, client });
      if (worked) continue;
    } catch (error) {
      log.error("retention_loop_error", { error: sanitizedError(error) });
    }
    await delay(60_000);
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
void retentionLoop();

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
