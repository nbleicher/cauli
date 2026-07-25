import type { ScoreAnswer } from "./types.js";

export function calculateNormalizedScore(answers: ScoreAnswer[]): number | null {
  const applicable = answers.filter(
    (answer): answer is ScoreAnswer & { value: 1 | 2 | 3 | 4 | 5 } =>
      answer.value !== null && Number.isFinite(answer.weight) && answer.weight > 0,
  );

  if (applicable.length === 0) return null;

  const totalWeight = applicable.reduce((total, answer) => total + answer.weight, 0);
  const weightedScore = applicable.reduce(
    (total, answer) => total + ((answer.value - 1) / 4) * answer.weight,
    0,
  );

  return Math.round((weightedScore / totalWeight) * 10_000) / 100;
}
