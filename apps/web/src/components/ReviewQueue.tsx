"use client";

import type { Role } from "@calllog/shared";
import { LoaderCircle, UserCheck, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { CallTableRow } from "@/components/CallTable";
import { formatDate } from "@/lib/format";

interface EligibleAssignee {
  id: string;
  name: string;
  role: "manager" | "admin";
}

type QueueFilter = "unassigned" | "mine" | "all";

export function ReviewQueue({
  calls,
  assignees,
  currentUserId,
  role,
}: {
  calls: CallTableRow[];
  assignees: EligibleAssignee[];
  currentUserId: string;
  role: Role;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<QueueFilter>("unassigned");
  const [selectedCallIds, setSelectedCallIds] = useState<string[]>([]);
  const [bulkAssigneeId, setBulkAssigneeId] = useState(assignees[0]?.id ?? "");
  const [rowAssignees, setRowAssignees] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState("");
  const [error, setError] = useState("");

  const reviewableCalls = useMemo(
    () =>
      calls
        .filter((call) => call.status === "ready")
        .filter((call) => {
          if (filter === "unassigned") return !call.reviewAssigneeId;
          if (filter === "mine") return call.reviewAssigneeId === currentUserId;
          return true;
        }),
    [calls, currentUserId, filter]
  );

  async function mutate(
    key: string,
    payload:
      | { action: "claim"; callId: string }
      | {
          action: "assign";
          callId: string;
          assigneeId: string;
          expectedAssignmentVersion: number;
        }
      | { action: "bulkAssign"; callIds: string[]; assigneeId: string }
  ) {
    setSavingKey(key);
    setError("");
    try {
      const response = await fetch("/api/reviews/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "Review assignment could not be saved");
      }
      setSelectedCallIds([]);
      router.refresh();
    } catch (assignmentError) {
      setError(
        assignmentError instanceof Error
          ? assignmentError.message
          : "Review assignment could not be saved"
      );
    } finally {
      setSavingKey("");
    }
  }

  return (
    <section className="admin-section review-queue">
      <div className="section-heading">
        <div>
          <h2>Review queue</h2>
          <p>
            Claim unassigned Reviews or assign them to one accountable person.
          </p>
        </div>
        <select
          aria-label="Review queue filter"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value as QueueFilter);
            setSelectedCallIds([]);
          }}
        >
          <option value="unassigned">Unassigned</option>
          <option value="mine">Assigned to me</option>
          <option value="all">All ready Calls</option>
        </select>
      </div>

      {role === "admin" && reviewableCalls.length > 0 && (
        <div className="bulk-assignment">
          <label>
            <input
              type="checkbox"
              checked={
                reviewableCalls.every((call) =>
                  selectedCallIds.includes(call.id)
                ) && reviewableCalls.length > 0
              }
              onChange={(event) =>
                setSelectedCallIds(
                  event.target.checked
                    ? reviewableCalls.map((call) => call.id)
                    : []
                )
              }
            />
            Select filtered Calls
          </label>
          <select
            aria-label="Bulk Review Assignee"
            value={bulkAssigneeId}
            onChange={(event) => setBulkAssigneeId(event.target.value)}
          >
            {assignees.map((assignee) => (
              <option key={assignee.id} value={assignee.id}>
                {assignee.name} · {assignee.role}
              </option>
            ))}
          </select>
          <button
            className="button button-secondary"
            disabled={
              selectedCallIds.length === 0 ||
              !bulkAssigneeId ||
              Boolean(savingKey)
            }
            onClick={() =>
              void mutate("bulk", {
                action: "bulkAssign",
                callIds: selectedCallIds,
                assigneeId: bulkAssigneeId,
              })
            }
          >
            {savingKey === "bulk" ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Users size={15} />
            )}
            Assign selected
          </button>
        </div>
      )}

      {reviewableCalls.length === 0 ? (
        <p className="empty-copy">No Calls match this Review queue filter.</p>
      ) : (
        <div className="review-queue-list">
          {reviewableCalls.map((call) => {
            const selectedAssigneeId =
              rowAssignees[call.id] ??
              call.reviewAssigneeId ??
              assignees[0]?.id ??
              "";
            return (
              <div
                className={`review-queue-row ${
                  role === "admin" ? "" : "review-queue-row-manager"
                }`}
                key={call.id}
              >
                {role === "admin" && (
                  <input
                    type="checkbox"
                    aria-label={`Select ${call.title || call.id}`}
                    checked={selectedCallIds.includes(call.id)}
                    onChange={(event) =>
                      setSelectedCallIds((current) =>
                        event.target.checked
                          ? [...current, call.id]
                          : current.filter((id) => id !== call.id)
                      )
                    }
                  />
                )}
                <div>
                  <strong>{call.title || formatDate(call.startedAt)}</strong>
                  <span>
                    {call.ownerName} · {call.reviewAssigneeName ?? "Unassigned"}
                  </span>
                </div>
                {role === "admin" ? (
                  <>
                    <select
                      aria-label={`Review Assignee for ${call.title || call.id}`}
                      value={selectedAssigneeId}
                      onChange={(event) =>
                        setRowAssignees((current) => ({
                          ...current,
                          [call.id]: event.target.value,
                        }))
                      }
                    >
                      {assignees.map((assignee) => (
                        <option key={assignee.id} value={assignee.id}>
                          {assignee.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="button button-quiet"
                      disabled={!selectedAssigneeId || Boolean(savingKey)}
                      onClick={() =>
                        void mutate(call.id, {
                          action: "assign",
                          callId: call.id,
                          assigneeId: selectedAssigneeId,
                          expectedAssignmentVersion: call.assignmentVersion,
                        })
                      }
                    >
                      {savingKey === call.id ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <UserCheck size={14} />
                      )}
                      {call.reviewAssigneeId ? "Reassign" : "Assign"}
                    </button>
                  </>
                ) : (
                  <button
                    className="button button-secondary"
                    disabled={
                      Boolean(call.reviewAssigneeId) || Boolean(savingKey)
                    }
                    onClick={() =>
                      void mutate(call.id, {
                        action: "claim",
                        callId: call.id,
                      })
                    }
                  >
                    {savingKey === call.id && (
                      <LoaderCircle className="spin" size={14} />
                    )}
                    Claim Review
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
