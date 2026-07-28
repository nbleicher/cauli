import assert from "node:assert/strict";
import test from "node:test";
import { validateRecoveryDrills } from "./recovery-drill.mjs";

const now = new Date("2026-07-28T12:00:00Z");
const daysAgo = (days) =>
  new Date(now.getTime() - days * 86_400_000).toISOString();

const complete = {
  now,
  peelySyncHours: 12,
  drills: [
    {
      kind: "database_point_in_time",
      performedAt: daysAgo(10),
      evidenceReference: "drill-pitr-2026-07",
      recoverySeconds: 5_400,
      succeeded: true,
    },
    {
      kind: "kms_source_audio_restore",
      performedAt: daysAgo(20),
      evidenceReference: "drill-kms-2026-07",
      recoverySeconds: 900,
      succeeded: true,
    },
    {
      kind: "seal_inspection",
      performedAt: daysAgo(30),
      evidenceReference: "drill-seals-2026-06",
      succeeded: true,
    },
    {
      kind: "offline_age_restore",
      performedAt: daysAgo(120),
      evidenceReference: "drill-offline-2026-03",
      recoverySeconds: 10_800,
      succeeded: true,
    },
  ],
};

test("accepts complete and current recovery evidence", () => {
  assert.doesNotThrow(() => validateRecoveryDrills(complete));
});

test("requires every drill to have actually happened", () => {
  for (const kind of [
    "database_point_in_time",
    "kms_source_audio_restore",
    "seal_inspection",
    "offline_age_restore",
  ]) {
    assert.throws(
      () =>
        validateRecoveryDrills({
          ...complete,
          drills: complete.drills.filter((drill) => drill.kind !== kind),
        }),
      /has never been demonstrated/,
      kind
    );
  }
});

test("treats a quarterly drill older than a quarter as absent", () => {
  assert.throws(
    () =>
      validateRecoveryDrills({
        ...complete,
        drills: complete.drills.map((drill) =>
          drill.kind === "kms_source_audio_restore"
            ? { ...drill, performedAt: daysAgo(100) }
            : drill
        ),
      }),
    /KMS Source Audio restore is older than 92 days/
  );
});

test("does not let a failed drill stand in for a successful one", () => {
  assert.throws(
    () =>
      validateRecoveryDrills({
        ...complete,
        drills: complete.drills.map((drill) =>
          drill.kind === "seal_inspection"
            ? { ...drill, succeeded: false, remediation: "reseal scheduled" }
            : drill
        ),
      }),
    /seal inspection has never been demonstrated/
  );
});

test("requires a remediation record for a drill that failed", () => {
  assert.throws(
    () =>
      validateRecoveryDrills({
        ...complete,
        drills: [
          ...complete.drills,
          {
            kind: "kms_source_audio_restore",
            performedAt: daysAgo(1),
            evidenceReference: "drill-kms-failed",
            succeeded: false,
          },
        ],
      }),
    /no remediation record/
  );
});

test("holds the demonstrated recovery time to four hours", () => {
  assert.throws(
    () =>
      validateRecoveryDrills({
        ...complete,
        drills: complete.drills.map((drill) =>
          drill.kind === "offline_age_restore"
            ? { ...drill, recoverySeconds: 5 * 60 * 60 }
            : drill
        ),
      }),
    /exceeds the four-hour objective/
  );

  assert.throws(
    () =>
      validateRecoveryDrills({
        ...complete,
        drills: complete.drills.map((drill) => ({
          ...drill,
          recoverySeconds: undefined,
        })),
      }),
    /recorded how long it took/
  );

  // Evidence is append-only, so one honest slow drill from two years ago must
  // not condemn every promotion after it. Once it is too old to satisfy the
  // schedule it is too old to fail it.
  assert.doesNotThrow(() =>
    validateRecoveryDrills({
      ...complete,
      drills: [
        ...complete.drills,
        {
          kind: "database_point_in_time",
          performedAt: daysAgo(700),
          evidenceReference: "drill-pitr-2024-08",
          recoverySeconds: 6 * 60 * 60,
          succeeded: true,
        },
      ],
    })
  );
});

test("requires the offline copy to be fresh", () => {
  assert.throws(
    () => validateRecoveryDrills({ ...complete, peelySyncHours: 60 }),
    /has not synchronized within 48 hours/
  );
  assert.throws(
    () => validateRecoveryDrills({ ...complete, peelySyncHours: undefined }),
    /has not synchronized within 48 hours/
  );
});
