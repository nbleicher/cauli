"use client";

import type { ReviewStatus } from "@calllog/shared";
import { calculateNormalizedScore } from "@calllog/shared";
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
  status: ReviewStatus;
  score: number | null;
  submittedAt: string;
  submittedBy: string;
}

export interface ReviewEditorProps {
  callId: string;
  scorecardVersionId: string;
  scorecardName: string;
  categories: Category[];
  initialReview: {
    version: number;
    status: ReviewStatus;
    summary: string;
    answers: ReviewAnswer[];
  } | null;
  revisions: Revision[];
  readOnly?: boolean;
}

export function ReviewEditor({
  callId,
  scorecardVersionId,
  scorecardName,
  categories,
  initialReview,
  revisions,
  readOnly = false,
}: ReviewEditorProps) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, ReviewAnswer>>(() => {
    const current = Object.fromEntries(
      (initialReview?.answers ?? []).map((answer) => [answer.criterionId, answer]),
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
  const [status, setStatus] = useState<Exclude<ReviewStatus, "unreviewed">>(
    initialReview?.status === "unreviewed" || !initialReview
      ? "in_progress"
      : initialReview.status,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const score = useMemo(() => calculateNormalizedScore(
    categories.flatMap((category) => category.criteria.map((criterion) => ({
      criterionId: criterion.id,
      weight: criterion.weight,
      value: answers[criterion.id]?.value ?? null,
    }))),
  ), [answers, categories]);

  function updateAnswer(
    criterionId: string,
    patch: Partial<ReviewAnswer>,
  ) {
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
            status,
            summary,
            answers: Object.values(answers),
          }),
        },
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? "This review changed in another session. Refresh before submitting."
            : result.error || "Review could not be saved",
        );
      }
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Review could not be saved");
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
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="in_progress">In progress</option>
            <option value="reviewed">Reviewed</option>
            <option value="needs_follow_up">Needs follow-up</option>
          </select>
        )}
      </div>

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
                <div className="score-options" role="group" aria-label={criterion.label}>
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button
                      key={value}
                      className={answer?.value === value ? "active" : ""}
                      onClick={() => updateAnswer(criterion.id, { value: value as 1 | 2 | 3 | 4 | 5 })}
                      disabled={readOnly}
                    >
                      {value}
                    </button>
                  ))}
                  <button
                    className={answer?.value === null ? "active na" : "na"}
                    onClick={() => updateAnswer(criterion.id, { value: null })}
                    disabled={readOnly}
                  >
                    N/A
                  </button>
                </div>
                {!readOnly && (
                  <input
                    value={answer?.comment ?? ""}
                    onChange={(event) => updateAnswer(criterion.id, { comment: event.target.value })}
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
          <p className="review-summary-readonly">{summary || "No summary provided."}</p>
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

      {error && <p className="form-error">{error}</p>}
      {!readOnly && (
        <button className="button button-primary button-full" onClick={() => void submit()} disabled={saving}>
          {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
          Submit review
        </button>
      )}

      {revisions.length > 0 && (
        <details className="review-history">
          <summary><History size={14} /> {revisions.length} submitted revision{revisions.length === 1 ? "" : "s"}</summary>
          <div>
            {revisions.map((revision) => (
              <p key={revision.id}>
                <Check size={13} />
                v{revision.revision} · {revision.status.replaceAll("_", " ")} · {revision.score ?? "—"} · {revision.submittedBy}
              </p>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
