type AssuranceLevel = string | null;

interface AssuranceLevelResult {
  data: {
    currentLevel: AssuranceLevel;
    nextLevel: AssuranceLevel;
  } | null;
  error: unknown;
}

export type SecondFactorRequirement = "satisfied" | "required" | "unavailable";

export function secondFactorRequirement({
  data,
  error,
}: AssuranceLevelResult): SecondFactorRequirement {
  if (error || !data) return "unavailable";
  return data.nextLevel === "aal2" && data.currentLevel !== "aal2"
    ? "required"
    : "satisfied";
}
