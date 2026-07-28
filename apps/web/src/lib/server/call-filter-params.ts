import {
  CALL_STATUSES,
  REVIEW_STATUSES,
  type CallStatus,
  type ReviewStatus,
} from "@calllog/shared";

export const CALL_PAGE_SIZE = 50;
export const MAX_SEARCH_LENGTH = 120;

export interface CallFilters {
  ownerId?: string;
  from?: string;
  to?: string;
  statuses?: CallStatus[];
  reviewStatuses?: ReviewStatus[];
  quality?: "complete" | "degraded";
  assigneeId?: string;
  unassigned?: boolean;
  followUp?: "open" | "overdue" | "awaiting_verification" | "verified";
  search?: string;
}

export function encodeCallCursor(row: { startedAt: string; id: string }) {
  return `${row.startedAt}|${row.id}`;
}

/**
 * A cursor is opaque to the browser but not trusted from it. Anything that is
 * not exactly a timestamp and an identifier is treated as no cursor at all,
 * which lands the reader on the first page rather than on an error.
 */
export function decodeCallCursor(value: string | undefined | null) {
  if (!value) return null;
  const separator = value.lastIndexOf("|");
  if (separator <= 0) return null;
  const startedAt = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (Number.isNaN(Date.parse(startedAt))) return null;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    return null;
  }
  return { startedAt, id };
}

export type SearchParams = Record<string, string | string[] | undefined>;

function single(params: SearchParams, key: string) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

function uuid(value: string | undefined) {
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
    ? value
    : undefined;
}

/**
 * Query strings arrive from the browser, so nothing here trusts them. A value
 * that is not one of the states this product actually has is dropped rather
 * than passed down: an unknown filter should show the unfiltered list, not an
 * error page and not an unbounded query.
 */
function isoDate(value: string | undefined, endOfDay: boolean) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(
    `${value}T${endOfDay ? "23:59:59.999" : "00:00:00"}Z`
  );
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function parseCallFilters(
  params: SearchParams,
  viewer: { userId: string; ownedOnly: boolean }
): CallFilters {
  const status = single(params, "status");
  const review = single(params, "review");
  const quality = single(params, "quality");
  const followUp = single(params, "followup");
  const assignment = single(params, "assignment");
  const search = single(params, "q")?.trim().slice(0, 120);
  const selectedOwner = uuid(single(params, "owner"));

  return {
    ownerId: viewer.ownedOnly ? viewer.userId : selectedOwner,
    from: isoDate(single(params, "from"), false),
    to: isoDate(single(params, "to"), true),
    statuses: CALL_STATUSES.includes(status as CallStatus)
      ? [status as CallStatus]
      : undefined,
    reviewStatuses: REVIEW_STATUSES.includes(review as ReviewStatus)
      ? [review as ReviewStatus]
      : undefined,
    quality:
      quality === "complete" || quality === "degraded" ? quality : undefined,
    // "Assigned to me" and "unassigned" are different questions, and only one
    // of them can be expressed as an identifier.
    assigneeId:
      assignment === "mine"
        ? viewer.userId
        : assignment !== "unassigned"
          ? uuid(assignment)
          : undefined,
    unassigned: assignment === "unassigned",
    followUp:
      followUp === "open" ||
      followUp === "overdue" ||
      followUp === "awaiting_verification" ||
      followUp === "verified"
        ? followUp
        : undefined,
    search: search || undefined,
  };
}

export function hasActiveCallFilters(params: SearchParams) {
  return [
    "q",
    "status",
    "review",
    "quality",
    "from",
    "to",
    "owner",
    "assignment",
    "followup",
  ].some((key) => Boolean(single(params, key)));
}
