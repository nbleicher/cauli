"use client";

import { CALL_STATUSES, REVIEW_STATUSES } from "@calllog/shared";
import { Search, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

interface FilterPerson {
  id: string;
  name: string;
}

/**
 * Filters live in the URL rather than in component state so a filtered page is
 * shareable, survives a refresh, and pairs with the cursor the server hands
 * back. Changing any filter drops the cursor: page two of one question is not
 * page two of another.
 */
export function CallFilters({
  showOwner,
  owners = [],
  assignees = [],
}: {
  showOwner: boolean;
  owners?: FilterPerson[];
  assignees?: FilterPerson[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");

  function apply(changes: Record<string, string>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    next.delete("cursor");
    const query = next.toString();
    router.push(query ? `?${query}` : "?");
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    apply({ q: search.trim().slice(0, 120) });
  }

  const active = [
    "q",
    "status",
    "review",
    "quality",
    "from",
    "to",
    "owner",
    "assignment",
    "followup",
  ].some((key) => params.get(key));

  return (
    <section className="call-filters" aria-label="Call filters">
      <form className="call-search" onSubmit={submitSearch} role="search">
        <div className="input-with-icon">
          <Search size={15} />
          <input
            aria-label="Search Calls"
            placeholder={
              showOwner ? "Search by title or owner" : "Search by title"
            }
            maxLength={120}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <button className="button button-secondary">Search</button>
      </form>

      <div className="call-filter-row">
        <label>
          <span>Processing</span>
          <select
            value={params.get("status") ?? ""}
            onChange={(event) => apply({ status: event.target.value })}
          >
            <option value="">Any</option>
            {CALL_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status === "failed"
                  ? "needs attention"
                  : status.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Review</span>
          <select
            value={params.get("review") ?? ""}
            onChange={(event) => apply({ review: event.target.value })}
          >
            <option value="">Any</option>
            {REVIEW_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Quality</span>
          <select
            value={params.get("quality") ?? ""}
            onChange={(event) => apply({ quality: event.target.value })}
          >
            <option value="">Any</option>
            <option value="complete">Complete</option>
            <option value="degraded">Degraded</option>
          </select>
        </label>

        {showOwner && (
          <>
            <label>
              <span>Owner</span>
              <select
                value={params.get("owner") ?? ""}
                onChange={(event) => apply({ owner: event.target.value })}
              >
                <option value="">Any</option>
                {owners.map((owner) => (
                  <option key={owner.id} value={owner.id}>
                    {owner.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Assignment</span>
              <select
                value={params.get("assignment") ?? ""}
                onChange={(event) => apply({ assignment: event.target.value })}
              >
                <option value="">Any</option>
                <option value="unassigned">Unassigned</option>
                <option value="mine">Assigned to me</option>
                {assignees.map((assignee) => (
                  <option key={assignee.id} value={assignee.id}>
                    {assignee.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        <label>
          <span>Follow-up</span>
          <select
            value={params.get("followup") ?? ""}
            onChange={(event) => apply({ followup: event.target.value })}
          >
            <option value="">Any</option>
            <option value="open">Open</option>
            <option value="overdue">Overdue</option>
            <option value="awaiting_verification">Awaiting verification</option>
            <option value="verified">Verified</option>
          </select>
        </label>

        <label>
          <span>From</span>
          <input
            type="date"
            value={params.get("from") ?? ""}
            onChange={(event) => apply({ from: event.target.value })}
          />
        </label>

        <label>
          <span>To</span>
          <input
            type="date"
            value={params.get("to") ?? ""}
            onChange={(event) => apply({ to: event.target.value })}
          />
        </label>

        {active && (
          <button
            className="button button-quiet"
            onClick={() => {
              setSearch("");
              router.push("?");
            }}
          >
            <X size={14} /> Clear filters
          </button>
        )}
      </div>
    </section>
  );
}
