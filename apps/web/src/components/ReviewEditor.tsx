"use client";

import type { ReviewStatus } from "@calllog/shared";
import {
  calculateNormalizedScore,
  validateReviewCompletion,
} from "@calllog/shared";
import { Check, History, LoaderCircle, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

interface Criterion {
  id: string;
  label: string;
  description: string;
  weight: number;
  required: boolean;
}

interface Category {
  id: string;
  name: string;
  criteria: Criterion[];
}

interface ReviewAnswer {
  criterionId: string;
  value: 1 | 2 | 3 | 4 | 5 | null;
  comment: string;
}

interface Revision {
  id: string;
  revision: number;
  scorecardVersionId: string;
  status: ReviewStatus;
  score: number | null;
  summary: string;
  followUp: string;
  followUpState: string;
  answers: ReviewAnswer[];
  submittedAt: string;
  submittedBy: string;
}

function sevenDaysFromToday() {
  const dueDate = new Date();
  dueDate.setUTCDate(dueDate.getUTCDate() + 7);
  return dueDate.toISOString().slice(0, 10);
}

export interface ReviewEditorProps {
  callId: string;
  scorecardVersionId: string;
  scorecardVersionNumber: number;
  scorecardName: string;
  categories: Category[];
  initialReview: {
    version: number;
    status: ReviewStatus;
    summary: string;
    followUp: string;
    followUpDueDate: string | null;
    answers: ReviewAnswer[];
  } | null;
  assignment: {
    assigneeId: string;
    assigneeName: string;
    version: number;
  } | null;
  revisions: Revision[];
  readOnly?: boolean;
}

export function ReviewEditor({
  callId,
  scorecardVersionId,
  scorecardVersionNumber,
  scorecardName,
  categories,
  initialReview,
  assignment,
  revisions,
  readOnly = false,
}: ReviewEditorProps) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, ReviewAnswer>>(() => {
    const current = Object.fromEntries(
      (initialReview?.answers ?? []).map((answer) => [
        answer.criterionId,
        answer,
      ])
    );
    for (const category of categories) {
      for (const criterion of category.criteria) {
        current[criterion.id] ??= {
          criterionId: criterion.id,
          value: null,
          comment: "",
        };
      }
    }
    return current;
  });
  const [summary, setSummary] = useState(initialReview?.summary ?? "");
  const [followUp, setFollowUp] = useState(initialReview?.followUp ?? "");
  const [followUpDueDate, setFollowUpDueDate] = useState(
    initialReview?.followUpDueDate ?? ""
  );
  const [status, setStatus] = useState<Exclude<ReviewStatus, "unreviewed">>(
    initialReview?.status === "unreviewed" || !initialReview
      ? "in_progress"
      : initialReview.status
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const score = useMemo(
    () =>
      calculateNormalizedScore(
        categories.flatMap((category) =>
          category.criteria.map((criterion) => ({
            criterionId: criterion.id,
            weight: criterion.weight,
            value: answers[criterion.id]?.value ?? null,
          }))
        )
      ),
    [answers, categories]
  );

  function updateAnswer(criterionId: string, patch: Partial<ReviewAnswer>) {
    setAnswers((current) => ({
      ...current,
      [criterionId]: {
        criterionId,
        value: current[criterionId]?.value ?? null,
        comment: current[criterionId]?.comment ?? "",
        ...patch,
      },
    }));
  }

  async function submit() {
    const reviewAnswers = Object.values(answers);
    const issues = validateReviewCompletion(
      {
        status,
        summary,
        followUp,
        followUpDueDate: status === "needs_follow_up" ? followUpDueDate : null,
        answers: reviewAnswers,
      },
      categories.flatMap((category) => category.criteria)
    );
    if (issues.length) {
      setError(issues.map((issue) => issue.message).join(" "));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(
        `/api/calls/${callId}/review?scorecardVersionId=${scorecardVersionId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedVersion: initialReview?.version ?? 0,
            expectedAssignmentVersion: assignment?.version ?? 0,
            status,
            summary,
            followUp,
            followUpDueDate:
              status === "needs_follow_up" ? followUpDueDate : null,
            answers: reviewAnswers,
          }),
        }
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? "This review changed in another session. Refresh before submitting."
            : result.error || "Review could not be saved"
        );
      }
      router.refresh();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Review could not be saved"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="scorecard">
      <div className="scorecard-summary">
        <div>
          <span>{scorecardName}</span>
          <strong>{score === null ? "—" : Math.round(score)}</strong>
          <small>/ 100</small>
        </div>
        {!readOnly && (
          <select
            value={status}
            onChange={(event) => {
              const nextStatus = event.target.value as typeof status;
              setStatus(nextStatus);
              if (nextStatus === "needs_follow_up" && !followUpDueDate) {
                setFollowUpDueDate(sevenDaysFromToday());
              }
            }}
          >
            <option value="in_progress">In progress</option>
            <option value="reviewed">Reviewed</option>
            <option value="needs_follow_up">Needs follow-up</option>
          </select>
        )}
      </div>
      <p className="review-assignee">
        Review Assignee: {assignment?.assigneeName ?? "Unassigned"}
      </p>

      {categories.map((category) => (
        <div className="score-category" key={category.id}>
          <h3>{category.name}</h3>
          {category.criteria.map((criterion) => {
            const answer = answers[criterion.id];
            return (
              <div className="score-criterion" key={criterion.id}>
                <div className="criterion-heading">
                  <div>
                    <strong>{criterion.label}</strong>
                    {criterion.description && <p>{criterion.description}</p>}
                  </div>
                  <span>×{criterion.weight}</span>
                </div>
                <div
                  className="score-options"
                  role="group"
                  aria-label={criterion.label}
                >
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button
                      key={value}
                      className={answer?.value === value ? "active" : ""}
                      onClick={() =>
                        updateAnswer(criterion.id, {
                          value: value as 1 | 2 | 3 | 4 | 5,
                        })
                      }
                      disabled={readOnly}
                    >
                      {value}
                    </button>
                  ))}
                  {!criterion.required && (
                    <button
                      className={answer?.value === null ? "active na" : "na"}
                      onClick={() =>
                        updateAnswer(criterion.id, { value: null })
                      }
                      disabled={readOnly}
                    >
                      N/A
                    </button>
                  )}
                </div>
                {!readOnly && (
                  <input
                    value={answer?.comment ?? ""}
                    onChange={(event) =>
                      updateAnswer(criterion.id, {
                        comment: event.target.value,
                      })
                    }
                    placeholder="Criterion note"
                    maxLength={4_000}
                  />
                )}
              </div>
            );
          })}
        </div>
      ))}

      <div className="field">
        <label htmlFor="review-summary">Review summary</label>
        {readOnly ? (
          <p className="review-summary-readonly">
            {summary || "No summary provided."}
          </p>
        ) : (
          <textarea
            id="review-summary"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="What went well, what should change, and any follow-up needed."
            maxLength={10_000}
          />
        )}
      </div>

      {status === "needs_follow_up" && (
        <div className="field">
          <label htmlFor="review-follow-up">Required follow-up</label>
          {readOnly ? (
            <p className="review-summary-readonly">
              {followUp || "No follow-up explanation provided."}
            </p>
          ) : (
            <textarea
              id="review-follow-up"
              value={followUp}
              onChange={(event) => setFollowUp(event.target.value)}
              placeholder="What specific action needs to happen, and who should own it?"
              maxLength={10_000}
            />
          )}
          {!readOnly && (
            <input
              type="date"
              aria-label="Follow-up due date"
              value={followUpDueDate}
              onChange={(event) => setFollowUpDueDate(event.target.value)}
              required
            />
          )}
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
      {!readOnly && (
        <button
          className="button button-primary button-full"
          onClick={() => void submit()}
          disabled={saving}
        >
          {saving ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Save size={16} />
          )}
          Submit review
        </button>
      )}

      {revisions.length > 0 && (
        <details className="review-history">
          <summary>
            <History size={14} /> {revisions.length} visible revision
            {revisions.length === 1 ? "" : "s"}
          </summary>
          <div className="revision-list">
            {revisions.map((revision) => (
              <details className="revision-card" key={revision.id}>
                <summary>
                  <Check size={13} />
                  Revision {revision.revision} ·{" "}
                  {revision.status.replaceAll("_", " ")} ·{" "}
                  {revision.score ?? "—"} · {revision.submittedBy}
                </summary>
                <div>
                  <p>
                    Scorecard Version {scorecardVersionNumber} ·{" "}
                    {new Date(revision.submittedAt).toLocaleString()}
                  </p>
                  <p>
                    <strong>Summary:</strong>{" "}
                    {revision.summary || "No summary provided."}
                  </p>
                  {revision.followUpState !== "not_required" && (
                    <p>
                      <strong>Follow-up:</strong>{" "}
                      {revision.followUp || revision.followUpState}
                    </p>
                  )}
                  <div className="revision-answers">
                    {revision.answers.map((answer) => {
                      const criterion = categories
                        .flatMap((category) => category.criteria)
                        .find((item) => item.id === answer.criterionId);
                      return (
                        <p key={answer.criterionId}>
                          <strong>
                            {criterion?.label ?? "Historical criterion"}:
                          </strong>{" "}
                          {answer.value ?? "N/A"}
                          {answer.comment ? ` · ${answer.comment}` : ""}
                        </p>
                      );
                    })}
                  </div>
                </div>
              </details>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
