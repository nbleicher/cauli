# Controlled-pilot production-readiness ticket map

## Sources of truth

- The [controlled-pilot production-readiness specification](controlled-pilot-production-readiness.md) defines product scope, user stories, implementation decisions, testing seams, and launch acceptance.
- The [human production-readiness runbook](../operations/human-production-readiness-runbook.md) defines every manual provider, custody, legal, device, operational, and release task.
- [GitHub Issue #7](https://github.com/nbleicher/cauli/issues/7) is the parent map.
- GitHub’s native sub-issue and blocked-by relationships are the authoritative live dependency graph.

## Implementation tickets

All implementation tickets retain the `ready-for-agent` label but are blocked by human Phase A ticket #40. The approved testing seams are Playwright user journeys, Supabase database contracts, worker/external-service contracts, and release/infrastructure acceptance.

| ID  | Issue | Tracer-bullet delivery                                      |
| --- | ----: | ----------------------------------------------------------- |
| T01 |    #8 | Canonical main and proprietary public repository            |
| T02 |    #9 | Isolated staging and immutable-digest promotion             |
| T03 |   #10 | Immutable Audit Events                                      |
| T04 |   #11 | Workspace boundaries and ten-member pilot cap               |
| T05 |   #12 | Versioned legal acceptance                                  |
| T06 |   #13 | Password-based Invitation Activation                        |
| T07 |   #14 | Role-aware TOTP MFA                                         |
| T08 |   #15 | Recovery Codes and TOTP replacement                         |
| T09 |   #16 | Session reauthentication and abuse controls                 |
| T10 |   #17 | Recording Attestation and supported capture gate            |
| T11 |   #18 | Durable recording lifecycle                                 |
| T12 |   #19 | Reliable processing state and polling                       |
| T13 |   #20 | Processing budgets and Budget Paused                        |
| T14 |   #21 | Processing capacity and content-scrubbed Sentry             |
| T15 |   #22 | Paginated Call discovery                                    |
| T16 |   #23 | Audited media and Transcript exports                        |
| T17 |   #24 | Optional Scorecard criteria and comparable versions         |
| T18 |   #25 | Review assignment and bulk assignment                       |
| T19 |   #26 | Complete immutable Review Revision history                  |
| T20 |   #27 | Tracked Follow-ups                                          |
| T21 |   #28 | Workspace quality dashboard                                 |
| T22 |   #29 | Mandatory Workspace Retention Policies                      |
| T23 |   #30 | Encrypted Source Audio backup to the shared Netcup VPS      |
| T24 |   #31 | Unified manual and retention deletion                       |
| T25 |   #32 | Peely synchronization and disaster recovery                 |
| T26 |   #33 | Safe Workspace Member offboarding                           |
| T27 |   #34 | Separate Platform Admin control plane                       |
| T28 |   #35 | Workspace provisioning, suspension, and closure             |
| T29 |   #36 | Kill switches, public status, and alerting                  |
| T30 |   #37 | Accessibility acceptance                                    |
| T31 |   #38 | Performance and support readiness                           |
| T32 |   #39 | Complete staging, disaster-recovery, and promotion sign-off |

## Human gates

| ID  | Issue | Label             | Gate                                                               |
| --- | ----: | ----------------- | ------------------------------------------------------------------ |
| H01 |   #40 | `ready-for-human` | Phase A provider and recovery bootstrap before implementation      |
| H02 |   #41 | `ready-for-human` | Operator approval of the non-counsel-reviewed pilot legal package  |
| H03 |   #42 | `ready-for-human` | Offline custody and disaster-recovery acceptance                   |
| H04 |   #43 | `ready-for-human` | Production infrastructure, region, and public-repository approval  |
| H05 |   #44 | `ready-for-human` | Real-device, accessibility, operations, and pre-promotion approval |

## Dependency policy

- #40 blocks #8–#39. Specifications and tickets may be maintained before #40 closes, but production-readiness implementation may not start.
- #41 is blocked by legal implementation #12.
- #42 is blocked by backup and recovery implementation #30 and #32.
- #43 is blocked by the repository, staging, Sentry, backup, Platform Admin, and operational-status implementations it must inspect.
- #44 is blocked by the complete staging candidate, #41, #42, and #43.
- Final agent sign-off and production promotion #39 is additionally blocked by #44.

The live frontier is therefore #40 until the operator completes runbook tasks H01–H11.
