import type { Role } from "@calllog/shared";

type AssuranceLevel = string | null;

interface AssuranceLevelResult {
  data: {
    currentLevel: AssuranceLevel;
    nextLevel: AssuranceLevel;
  } | null;
  error: unknown;
}

export type SecondFactorRequirement =
  "satisfied" | "enrollment_required" | "verification_required" | "unavailable";

export function secondFactorRequirement(
  role: Role,
  { data, error }: AssuranceLevelResult,
  recoveryPending = false
): SecondFactorRequirement {
  if (error || !data) return "unavailable";
  if (data.currentLevel === "aal2") return "satisfied";
  // Redeeming a Recovery Code deletes the factor. This is decided before the
  // next-level check because the session was minted while the factor still
  // existed and would otherwise offer a challenge for something deleted, and
  // before the Role check because "nothing enrolled" must not read as "this
  // Role never needed one" for a Member.
  if (recoveryPending) return "enrollment_required";
  if (data.nextLevel === "aal2") return "verification_required";
  return role === "member" ? "satisfied" : "enrollment_required";
}
