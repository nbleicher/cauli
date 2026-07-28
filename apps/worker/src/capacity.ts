/**
 * How many jobs one worker process should run at once.
 *
 * The pilot's promise is per-Call, not per-worker: a Call of an hour or less is
 * Ready within five minutes of Stop & Save. A burst of simultaneous Calls turns
 * that into an arithmetic question — with concurrency c, the last Call in a
 * burst of n waits for ceil(n / c) rounds of work before its own round starts.
 *
 * The inputs are measurements, not guesses, which is the point: sizing that
 * comes from a constant somebody once believed goes stale silently, while
 * sizing derived from a recorded burst can be re-derived on the hardware that
 * will actually run it.
 */

export interface CapacityMeasurement {
  /** Simultaneous Calls the pilot must absorb. */
  callsInBurst: number;
  /** Measured wall clock for one Call's own processing, end to end. */
  processingMsPerCall: number;
  /** Measured claim, lease, and commit overhead outside the work itself. */
  queueOverheadMs: number;
  /** The promise being kept, in milliseconds. */
  serviceLevelTargetMs: number;
}

export const PILOT_SERVICE_LEVEL_TARGET_MS = 300_000;
export const PILOT_BURST_CALLS = 5;

/**
 * The wait the last Call in the burst sees. Rounds are whole: a sixth Call
 * behind five workers waits a full extra round, not a fifth of one.
 */
export function projectedServiceLevelMs(
  measurement: CapacityMeasurement,
  concurrency: number
) {
  if (concurrency < 1) throw new Error("Concurrency must be at least one");
  const rounds = Math.ceil(measurement.callsInBurst / concurrency);
  return rounds * measurement.processingMsPerCall + measurement.queueOverheadMs;
}

/**
 * The smallest concurrency that keeps the promise for the whole burst, or the
 * burst size when even that is not enough — at which point the answer is not
 * more concurrency in one process but faster work or more worker processes,
 * and the caller is expected to notice the projection still misses.
 */
export function sizeWorkerConcurrency(measurement: CapacityMeasurement) {
  for (
    let concurrency = 1;
    concurrency <= measurement.callsInBurst;
    concurrency += 1
  ) {
    if (
      projectedServiceLevelMs(measurement, concurrency) <=
      measurement.serviceLevelTargetMs
    ) {
      return concurrency;
    }
  }
  return measurement.callsInBurst;
}

export function meetsServiceLevel(
  measurement: CapacityMeasurement,
  concurrency: number
) {
  return (
    projectedServiceLevelMs(measurement, concurrency) <=
    measurement.serviceLevelTargetMs
  );
}

/**
 * The recorded burst behind the shipped default. Written down here rather than
 * left in a runbook so the number and its justification cannot drift apart:
 * change the measurement and the default follows, and the capacity tests say
 * whether the promise still holds.
 *
 * See docs/operations/processing-capacity.md for how it was taken and for the
 * production re-measurement that release sign-off still owes.
 */
export const MEASURED_PILOT_CAPACITY: CapacityMeasurement = {
  callsInBurst: PILOT_BURST_CALLS,
  processingMsPerCall: 120_000,
  queueOverheadMs: 5_000,
  serviceLevelTargetMs: PILOT_SERVICE_LEVEL_TARGET_MS,
};

export const PILOT_WORKER_CONCURRENCY = sizeWorkerConcurrency(
  MEASURED_PILOT_CAPACITY
);
