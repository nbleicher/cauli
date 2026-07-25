import { createServer } from "node:http";
import { config } from "./config.js";
import { claimJob, cleanupAbandonedCalls, runJob } from "./jobs.js";
import { log, sanitizedError } from "./log.js";

let shuttingDown = false;
let activeJobs = 0;
let lastCleanupAt = 0;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    response.writeHead(shuttingDown ? 503 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: !shuttingDown,
      worker: config.workerName,
      activeJobs,
    }));
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
