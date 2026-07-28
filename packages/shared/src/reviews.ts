import type { ReviewStatus } from "./types.js";

export interface ReviewCompletionInput {
  status: Exclude<ReviewStatus, "unreviewed">;
  summary: string;
  followUp?: string;
  followUpDueDate?: string | null;
  answers: Array<{
    criterionId: string;
    value: number | null;
    comment?: string;
  }>;
}

export interface ReviewCriterion {
  id: string;
  required: boolean;
}

export interface ReviewValidationIssue {
  field: string;
  message: string;
}

export function validateReviewCompletion(
  review: ReviewCompletionInput,
  criteria: ReviewCriterion[]
): ReviewValidationIssue[] {
  if (review.status === "in_progress") return [];

  const issues: ReviewValidationIssue[] = [];
  if (!review.summary.trim()) {
    issues.push({
      field: "summary",
      message: "Submitted Reviews require a summary.",
    });
  }
  if (review.status === "needs_follow_up" && !review.followUp?.trim()) {
    issues.push({
      field: "followUp",
      message: "Needs Follow-up requires an explanation.",
    });
  }
  if (
    review.status === "needs_follow_up" &&
    review.followUpDueDate !== undefined &&
    !review.followUpDueDate
  ) {
    issues.push({
      field: "followUpDueDate",
      message: "Needs Follow-up requires a due date.",
    });
  }

  const answers = new Map(
    review.answers.map((answer) => [answer.criterionId, answer])
  );
  for (const answer of review.answers) {
    if (
      answer.value !== null &&
      (!Number.isInteger(answer.value) || answer.value < 1 || answer.value > 5)
    ) {
      issues.push({
        field: `answers.${answer.criterionId}`,
        message: "Scores must be an integer from 1 to 5.",
      });
    }
  }
  for (const criterion of criteria) {
    if (!criterion.required || answers.get(criterion.id)?.value != null)
      continue;
    issues.push({
      field: `answers.${criterion.id}`,
      message: "Required criteria must have a score from 1 to 5.",
    });
  }
  return issues;
}
