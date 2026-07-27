import { describe, expect, it } from "vitest";
import { filtersToSearchParams, parseAuditFilters } from "./audit-filters";

describe("Audit Event filters", () => {
  it("normalizes bounded filters and a positive cursor", () => {
    const filters = parseAuditFilters(
      new URL(
        "https://cauli.test/admin/audit?action=workspace.invite.created&actor=abc&cursor=42&dateFrom=2026-07-01&dateTo=2026-07-27&entity=workspace_invite&entityId=invite-1"
      )
    );

    expect(filters).toEqual({
      action: "workspace.invite.created",
      actor: "abc",
      cursor: 42,
      dateFrom: "2026-07-01T00:00:00.000Z",
      dateTo: "2026-07-27T23:59:59.999Z",
      entity: "workspace_invite",
      entityId: "invite-1",
    });
    expect(filtersToSearchParams(filters).toString()).toContain(
      "dateFrom=2026-07-01"
    );
  });

  it("drops invalid dates and cursors", () => {
    const filters = parseAuditFilters(
      new URL(
        "https://cauli.test/admin/audit?cursor=-1&dateFrom=today&dateTo=2026-99-99"
      )
    );

    expect(filters.cursor).toBeNull();
    expect(filters.dateFrom).toBe("");
    expect(filters.dateTo).toBe("");
  });
});
