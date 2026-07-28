"use client";

import { CheckCheck, CircleCheck, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface FollowUpQueueItem {
  id: string;
  callId: string;
  callTitle: string | null;
  ownerName: string;
  reviewAssigneeName: string;
  description: string;
  dueDate: string;
  displayStatus: string;
  version: number;
  canResolve: boolean;
  canVerify: boolean;
}

export function FollowUpQueue({ items }: { items: FollowUpQueueItem[] }) {
  const router = useRouter();
  const [savingId, setSavingId] = useState("");
  const [error, setError] = useState("");

  async function transition(
    followUp: FollowUpQueueItem,
    action: "resolve" | "verify"
  ) {
    setSavingId(followUp.id);
    setError("");
    try {
      const response = await fetch(`/api/follow-ups/${followUp.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          expectedVersion: followUp.version,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "Follow-up could not be updated");
      }
      router.refresh();
    } catch (transitionError) {
      setError(
        transitionError instanceof Error
          ? transitionError.message
          : "Follow-up could not be updated"
      );
    } finally {
      setSavingId("");
    }
  }

  if (items.length === 0) {
    return (
      <div className="empty-state">
        <CircleCheck size={38} />
        <h2>No open Follow-ups</h2>
        <p>There is no open or Overdue work in your queue.</p>
      </div>
    );
  }

  return (
    <div className="follow-up-list">
      {items.map((followUp) => (
        <article className="follow-up-card" key={followUp.id}>
          <div>
            <span className={`follow-up-status ${followUp.displayStatus}`}>
              {followUp.displayStatus.replaceAll("_", " ")}
            </span>
            <h2>
              <Link href={`/calls/${followUp.callId}`}>
                {followUp.callTitle || "Untitled Call"}
              </Link>
            </h2>
            <p>{followUp.description}</p>
          </div>
          <dl>
            <div>
              <dt>Due</dt>
              <dd>{followUp.dueDate}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>{followUp.ownerName}</dd>
            </div>
            <div>
              <dt>Review Assignee</dt>
              <dd>{followUp.reviewAssigneeName}</dd>
            </div>
          </dl>
          <div className="follow-up-actions">
            {followUp.canResolve && (
              <button
                className="button button-secondary"
                disabled={savingId === followUp.id}
                onClick={() => void transition(followUp, "resolve")}
              >
                {savingId === followUp.id ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <CircleCheck size={15} />
                )}
                Mark Resolved
              </button>
            )}
            {followUp.canVerify && (
              <button
                className="button button-primary"
                disabled={savingId === followUp.id}
                onClick={() => void transition(followUp, "verify")}
              >
                {savingId === followUp.id ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <CheckCheck size={15} />
                )}
                Verify closure
              </button>
            )}
          </div>
        </article>
      ))}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
