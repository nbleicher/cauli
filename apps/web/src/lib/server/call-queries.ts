import type { CallStatus, ReviewStatus, SourceMode } from "@calllog/shared";
import type { CallTableRow } from "@/components/CallTable";
import {
  CALL_PAGE_SIZE,
  decodeCallCursor,
  encodeCallCursor,
  MAX_SEARCH_LENGTH,
  type CallFilters,
} from "@/lib/server/call-filter-params";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export interface CallPage {
  calls: CallTableRow[];
  /** Opaque `startedAt|id` pair for the next page, or null at the end. */
  nextCursor: string | null;
}

interface RawPageRow {
  id: string;
  title: string | null;
  source_mode: SourceMode;
  status: CallStatus;
  review_status: ReviewStatus;
  started_at: string;
  duration_ms: number;
  degraded: boolean;
  owner_id: string;
  owner_name: string;
  assignee_name: string | null;
}

export async function listCallsPage(
  filters: CallFilters = {},
  cursor?: string | null
): Promise<CallPage> {
  const supabase = await createServerSupabaseClient();
  const decoded = decodeCallCursor(cursor);
  const { data, error } = await supabase.rpc("list_calls_page", {
    target_owner_id: filters.ownerId ?? null,
    target_from: filters.from ?? null,
    target_to: filters.to ?? null,
    target_statuses: filters.statuses?.length ? filters.statuses : null,
    target_review_statuses: filters.reviewStatuses?.length
      ? filters.reviewStatuses
      : null,
    target_quality: filters.quality ?? null,
    target_assignee_id: filters.assigneeId ?? null,
    target_unassigned: filters.unassigned ?? false,
    target_follow_up: filters.followUp ?? null,
    target_search: filters.search?.slice(0, MAX_SEARCH_LENGTH) ?? null,
    cursor_started_at: decoded?.startedAt ?? null,
    cursor_id: decoded?.id ?? null,
  });
  if (error) throw error;

  // The database returns one row past the page so the caller can tell whether
  // another page exists without counting the remainder.
  const rows = (data ?? []) as RawPageRow[];
  const page = rows.slice(0, CALL_PAGE_SIZE);
  const calls: CallTableRow[] = page.map((call) => ({
    id: call.id,
    title: call.title,
    ownerName: call.owner_name,
    assigneeName: call.assignee_name,
    sourceMode: call.source_mode,
    status: call.status,
    reviewStatus: call.review_status,
    startedAt: call.started_at,
    durationMs: call.duration_ms,
    degraded: call.degraded,
  }));
  const last = page[page.length - 1];
  return {
    calls,
    nextCursor:
      rows.length > CALL_PAGE_SIZE && last
        ? encodeCallCursor({ startedAt: last.started_at, id: last.id })
        : null,
  };
}
