#!/usr/bin/env node

import { pathToFileURL } from "node:url";

/**
 * Recovery is a release gate, not an aspiration. This refuses a promotion whose
 * recovery evidence has gone stale, whose offline path has never been proven
 * with the real tool, or whose demonstrated recovery time is slower than the
 * four-hour objective.
 *
 * It reads only content-free drill records — a kind, a timestamp, a reference,
 * and whether it worked. Never what was recovered.
 */

const QUARTER_DAYS = 92;
const RECOVERY_TIME_OBJECTIVE_SECONDS = 4 * 60 * 60;
const PEELY_SYNC_THRESHOLD_HOURS = 48;

/** Every drill that must have happened, and how recently. */
const requiredDrills = [
  {
    kind: "database_point_in_time",
    label: "A database point-in-time recovery",
    withinDays: QUARTER_DAYS,
  },
  {
    kind: "kms_source_audio_restore",
    label: "A KMS Source Audio restore",
    withinDays: QUARTER_DAYS,
  },
  {
    kind: "seal_inspection",
    label: "An offline recovery bundle seal inspection",
    withinDays: QUARTER_DAYS,
  },
  {
    // Proven before launch, after each rotation, and annually — so a year is
    // the standing interval once the pre-launch proof exists.
    kind: "offline_age_restore",
    label: "An offline age identity restore",
    withinDays: 365,
  },
];

function daysBetween(later, earlier) {
  return (later.getTime() - earlier.getTime()) / 86_400_000;
}

export function validateRecoveryDrills({
  drills,
  peelyLastSuccessAt,
  now = new Date(),
}) {
  if (!Array.isArray(drills)) {
    throw new Error("Recovery drill evidence is missing");
  }

  for (const drill of drills) {
    if (drill.succeeded === false && !String(drill.remediation ?? "").trim()) {
      throw new Error(
        `The failed ${drill.kind} drill has no remediation record`
      );
    }
  }

  for (const required of requiredDrills) {
    const candidates = drills
      .filter((drill) => drill.kind === required.kind && drill.succeeded)
      .map((drill) => ({ ...drill, performedAt: new Date(drill.performedAt) }))
      .filter((drill) => !Number.isNaN(drill.performedAt.valueOf()))
      .sort((first, second) => second.performedAt - first.performedAt);

    const latest = candidates[0];
    if (!latest) {
      throw new Error(`${required.label} has never been demonstrated`);
    }
    if (daysBetween(now, latest.performedAt) > required.withinDays) {
      throw new Error(
        `${required.label} is older than ${required.withinDays} days`
      );
    }
    if (!String(latest.evidenceReference ?? "").trim()) {
      throw new Error(`${required.label} has no evidence reference`);
    }
  }

  // The objective is what was demonstrated, not what was hoped for, so the
  // slowest proven restore is the one that has to fit inside four hours.
  //
  // Only drills still inside their own freshness window count. A drill records
  // what recovery took at the time; once it is too old to satisfy the schedule
  // it is too old to condemn the schedule either, and rows are append-only, so
  // a single slow early drill would otherwise block every promotion forever.
  const timedRestores = drills.filter((drill) => {
    const required = requiredDrills.find((entry) => entry.kind === drill.kind);
    if (!required || !drill.succeeded) return false;
    if (typeof drill.recoverySeconds !== "number") return false;
    const performedAt = new Date(drill.performedAt);
    if (Number.isNaN(performedAt.valueOf())) return false;
    return daysBetween(now, performedAt) <= required.withinDays;
  });
  if (!timedRestores.length) {
    throw new Error("No recovery drill recorded how long it took");
  }
  const slowest = Math.max(
    ...timedRestores.map((drill) => drill.recoverySeconds)
  );
  if (slowest > RECOVERY_TIME_OBJECTIVE_SECONDS) {
    throw new Error(
      `The demonstrated recovery time of ${Math.round(slowest / 60)} minutes exceeds the four-hour objective`
    );
  }

  const lastPeelySync = new Date(peelyLastSuccessAt);
  const peelySyncHours =
    (now.getTime() - lastPeelySync.getTime()) / (60 * 60 * 1_000);
  if (
    Number.isNaN(lastPeelySync.valueOf()) ||
    peelySyncHours < 0 ||
    peelySyncHours > PEELY_SYNC_THRESHOLD_HOURS
  ) {
    throw new Error(
      "The Peely offline copy has not synchronized within 48 hours"
    );
  }
}

async function run() {
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`,
  };
  const [drillResponse, peelyResponse] = await Promise.all([
    fetch(
      `${process.env.SUPABASE_URL}/rest/v1/recovery_drills?select=kind,performed_at,evidence_reference,recovery_seconds,succeeded,remediation`,
      { headers }
    ),
    fetch(
      `${process.env.SUPABASE_URL}/rest/v1/peely_sync_runs?select=completed_at&completed_at=not.is.null&failure_reason=is.null&order=completed_at.desc&limit=1`,
      { headers }
    ),
  ]);
  if (!drillResponse.ok) {
    throw new Error(
      `Unable to read recovery drill evidence (${drillResponse.status})`
    );
  }
  if (!peelyResponse.ok) {
    throw new Error(
      `Unable to read Peely freshness evidence (${peelyResponse.status})`
    );
  }
  const rows = await drillResponse.json();
  const peelyRows = await peelyResponse.json();
  validateRecoveryDrills({
    drills: rows.map((row) => ({
      kind: row.kind,
      performedAt: row.performed_at,
      evidenceReference: row.evidence_reference,
      recoverySeconds: row.recovery_seconds,
      succeeded: row.succeeded,
      remediation: row.remediation,
    })),
    peelyLastSuccessAt: peelyRows[0]?.completed_at,
  });
  console.log("Recovery drill evidence is complete and current.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
