import { createServer } from "node:http";
import {
  captureWorkerError,
  flushTelemetry,
  traceWorkerJob,
} from "./telemetry.js";
import { config } from "./config.js";
import {
  assertTranscriptionModelsPriced,
  claimJob,
  cleanupAbandonedCalls,
  readOperationalMetrics,
  resumeBudgetPausedJobs,
  runJob,
} from "./jobs.js";
import { log, sanitizedError } from "./log.js";

let shuttingDown = false;
let activeJobs = 0;
let lastCleanupAt = 0;
let lastBudgetResumeAt = 0;

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
      if (Date.now() - lastBudgetResumeAt > config.budgetResumeMs) {
        lastBudgetResumeAt = Date.now();
        await resumeBudgetPausedJobs();
      }
      const job = await claimJob();
      if (!job) {
        await delay(config.pollMs);
        continue;
      }
      activeJobs += 1;
      await traceWorkerJob(job, () => runJob(job));
      activeJobs -= 1;
    } catch (error) {
      activeJobs = Math.max(0, activeJobs - 1);
      log.error("worker_loop_error", {
        workerIndex: index,
        error: sanitizedError(error),
      });
      captureWorkerError(error, {
        workerIndex: index,
        errorClass:
          error instanceof Error ? error.constructor.name : "UnknownError",
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
        concurrency: config.concurrency,
      })
    );
    return;
  }
  // The alert set and the service level are separate from liveness on purpose:
  // a healthy worker can still be behind, and an operator needs to see that
  // without waiting for a sampled telemetry event to arrive.
  if (request.url === "/metrics") {
    void readOperationalMetrics()
      .then((metrics) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(metrics));
      })
      .catch((error) => {
        captureWorkerError(error, {
          errorClass:
            error instanceof Error ? error.constructor.name : "UnknownError",
        });
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: sanitizedError(error) }));
      });
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

try {
  await assertTranscriptionModelsPriced();
} catch (error) {
  log.error("worker_pricing_unconfigured", { error: sanitizedError(error) });
  captureWorkerError(error, {
    errorClass:
      error instanceof Error ? error.constructor.name : "UnknownError",
  });
  await flushTelemetry();
  process.exit(1);
}

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
  await flushTelemetry();
  process.exit(activeJobs > 0 ? 1 : 0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
