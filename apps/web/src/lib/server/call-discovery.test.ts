import { describe, expect, it } from "vitest";
import {
  decodeCallCursor,
  encodeCallCursor,
  hasActiveCallFilters,
  parseCallFilters,
} from "./call-filter-params";

const viewer = {
  userId: "11111111-1111-1111-1111-111111111111",
  ownedOnly: false,
};

describe("call cursors", () => {
  it("round-trips a cursor", () => {
    const cursor = encodeCallCursor({
      startedAt: "2026-06-01T10:00:00.000Z",
      id: "22222222-2222-2222-2222-222222222222",
    });
    expect(decodeCallCursor(cursor)).toEqual({
      startedAt: "2026-06-01T10:00:00.000Z",
      id: "22222222-2222-2222-2222-222222222222",
    });
  });

  it("treats anything it cannot trust as no cursor at all", () => {
    // A reader who edits the URL lands on page one rather than on an error.
    for (const value of [
      "",
      "nonsense",
      "2026-06-01T10:00:00.000Z|not-a-uuid",
      "not-a-date|22222222-2222-2222-2222-222222222222",
      "|22222222-2222-2222-2222-222222222222",
      "'; drop table calls;--|22222222-2222-2222-2222-222222222222",
    ]) {
      expect(decodeCallCursor(value)).toBeNull();
    }
    expect(decodeCallCursor(undefined)).toBeNull();
  });
});

describe("call filters", () => {
  it("keeps only states this product actually has", () => {
    expect(
      parseCallFilters(
        {
          status: "budget_paused",
          review: "needs_follow_up",
          quality: "degraded",
          followup: "open",
        },
        viewer
      )
    ).toMatchObject({
      statuses: ["budget_paused"],
      reviewStatuses: ["needs_follow_up"],
      quality: "degraded",
      followUp: "open",
    });

    expect(
      parseCallFilters(
        {
          status: "exploded",
          review: "vibes",
          quality: "great",
          followup: "x",
        },
        viewer
      )
    ).toMatchObject({
      statuses: undefined,
      reviewStatuses: undefined,
      quality: undefined,
      followUp: undefined,
    });
  });

  it("bounds the search text rather than passing it through", () => {
    expect(
      parseCallFilters({ q: "x".repeat(500) }, viewer).search
    ).toHaveLength(120);
    expect(parseCallFilters({ q: "   " }, viewer).search).toBeUndefined();
  });

  it("covers the whole final day of a date range", () => {
    const filters = parseCallFilters(
      { from: "2026-06-01", to: "2026-06-02" },
      viewer
    );
    expect(filters.from).toBe("2026-06-01T00:00:00.000Z");
    // A Call recorded at 5pm on the last day is inside "to 2 June".
    expect(filters.to).toBe("2026-06-02T23:59:59.999Z");
    expect(
      parseCallFilters({ from: "yesterday" }, viewer).from
    ).toBeUndefined();
  });

  it("distinguishes assigned-to-me from unassigned", () => {
    expect(parseCallFilters({ assignment: "mine" }, viewer)).toMatchObject({
      assigneeId: viewer.userId,
      unassigned: false,
    });
    expect(
      parseCallFilters({ assignment: "unassigned" }, viewer)
    ).toMatchObject({ assigneeId: undefined, unassigned: true });
  });

  it("pins a Member Role to their own Calls whatever the query string says", () => {
    const filters = parseCallFilters(
      { owner: "33333333-3333-3333-3333-333333333333" },
      { userId: viewer.userId, ownedOnly: true }
    );
    expect(filters.ownerId).toBe(viewer.userId);
  });

  it("knows when a filter is narrowing the list", () => {
    expect(hasActiveCallFilters({})).toBe(false);
    expect(hasActiveCallFilters({ cursor: "abc" })).toBe(false);
    expect(hasActiveCallFilters({ q: "renewal" })).toBe(true);
    expect(hasActiveCallFilters({ quality: "degraded" })).toBe(true);
  });
});
