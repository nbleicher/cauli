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
  { data, error }: AssuranceLevelResult
): SecondFactorRequirement {
  if (error || !data) return "unavailable";
  if (data.currentLevel === "aal2") return "satisfied";
  if (data.nextLevel === "aal2") return "verification_required";
  return role === "member" ? "satisfied" : "enrollment_required";
}
