# Processing capacity and observability

How Cauli keeps, measures, and reports the pilot's processing promise.

## The promise

At least 95% of Calls no longer than 60 minutes are Ready within five minutes
of Stop & Save, including queue time, under the demonstrated pilot load of five
simultaneous Calls.

Calls longer than 60 minutes and up to three hours remain fully supported. They
are measured and visible, but they are not counted against that percentage.

## Where the number comes from

`processing_runs` is the source of truth. Every attempt that reaches a terminal
state writes one content-free row through a database trigger, so the record
does not depend on the worker surviving, on a commit path being remembered, or
on a telemetry event being sampled.

Each row separates:

| Field              | Measures                                                      |
| ------------------ | ------------------------------------------------------------- |
| `queue_ms`         | Waiting for a worker to claim the job                         |
| `processing_ms`    | The work itself, once claimed                                 |
| `service_level_ms` | Stop & Save to finished — the clock the Workspace Member sees |

Queue and processing time are reported separately because they are fixed
differently: one by adding workers, the other by making the work faster. The
service-level result uses the combined, user-visible duration, which is why a
Budget Paused wait shows up in it even though the pause consumes no attempt.

`processing_service_level(window_hours)` returns the ratio, the p95 of each
stage, the count of long Calls excluded from the target, and the count of
provider incidents. Provider incidents are reported separately **and** remain
counted in the ratio: a bad hour at the transcription provider is visible as
its own signal without becoming an excuse.

## Worker concurrency

Concurrency is derived, not chosen. `apps/worker/src/capacity.ts` holds the
measurement and computes the default; `WORKER_CONCURRENCY` overrides it.

The arithmetic is about the _last_ Call in a burst. With concurrency `c`, the
fifth of five Calls waits `ceil(5 / c)` rounds before it is finished:

| Concurrency | Projected wait for the fifth Call | Meets the five-minute target |
| ----------- | --------------------------------- | ---------------------------- |
| 1           | 10m 05s                           | No                           |
| 2           | 6m 05s                            | No                           |
| 3           | 4m 05s                            | Yes                          |

Recorded measurement (staging, `supabase db reset` stack, five simultaneous
60-minute Calls):

- `processingMsPerCall`: 120,000 ms — a 60-minute Call splits into six
  10-minute transcription segments processed three at a time, so two provider
  rounds plus FFmpeg assembly.
- `queueOverheadMs`: 5,000 ms — claim, lease renewal, and commit, measured by
  `apps/worker/src/capacity.test.ts` against the real claim path.

**Shipped default: 3.**

`capacity.test.ts` fails if the default drops below what the recorded
measurement supports, so the number and its justification cannot drift apart.

### Still owed before production promotion

`processingMsPerCall` is a staging figure. Release sign-off (#39) must re-record
the five-Call burst on production hardware against the real provider and update
`MEASURED_PILOT_CAPACITY`. The capacity tests will then re-derive the default,
and `processing_service_level` over the load window is the acceptance evidence.

## Alerts

`processing_operational_alerts()` computes the alert set from durable evidence
rather than from sampled telemetry that may have been dropped for quota:

| Alert                          | Fires when                                              |
| ------------------------------ | ------------------------------------------------------- |
| `processing.queue_age`         | Oldest eligible job has waited more than five minutes   |
| `processing.service_level`     | 24-hour ratio below 95% with at least 20 eligible Calls |
| `processing.needs_attention`   | Three or more jobs exhausted their attempts in an hour  |
| `processing.provider_incident` | Three or more provider-class failures in an hour        |
| `processing.budget_threshold`  | A budget crossed its warning share today                |

Health-check failure is alerted outside the database, from the platform's own
probe against `/api/health` (web) and `/health` (worker).

## Retention

`processing_runs` keeps 90 days, purged by `purge_expired_processing_runs()`.
It carries no Call content: identifiers, timings, job kind, and error class
only.
