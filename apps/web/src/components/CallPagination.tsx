"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

/** Stands in for the first page, which has no cursor of its own. */
const START = "start";

/**
 * Keyset pagination only knows how to go forward, so the trail of cursors
 * already visited is what makes Previous possible. It lives in the URL beside
 * the current cursor, which keeps a page shareable and keeps the server free
 * of per-reader state.
 */
export function CallPagination({
  nextCursor,
  shown,
}: {
  nextCursor: string | null;
  shown: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const trail = params.get("trail");
  const history = trail ? trail.split("~").filter(Boolean) : [];
  const current = params.get("cursor");

  function go(cursor: string | null, nextHistory: string[]) {
    const next = new URLSearchParams(params.toString());
    if (cursor) next.set("cursor", cursor);
    else next.delete("cursor");
    if (nextHistory.length) next.set("trail", nextHistory.join("~"));
    else next.delete("trail");
    const query = next.toString();
    router.push(query ? `?${query}` : "?");
  }

  if (!nextCursor && history.length === 0) return null;

  return (
    <nav className="call-pagination" aria-label="Call pages">
      <button
        className="button button-quiet"
        disabled={history.length === 0}
        onClick={() => {
          // The first page has no cursor, so the trail records it as a marker
          // rather than as an empty string that would vanish on the round trip.
          const target = history[history.length - 1];
          go(target === START ? null : (target ?? null), history.slice(0, -1));
        }}
      >
        <ChevronLeft size={14} /> Previous
      </button>
      <span className="muted">
        {shown} {shown === 1 ? "Call" : "Calls"} on this page
      </span>
      <button
        className="button button-quiet"
        disabled={!nextCursor}
        onClick={() => go(nextCursor, [...history, current ?? START])}
      >
        Next <ChevronRight size={14} />
      </button>
    </nav>
  );
}
