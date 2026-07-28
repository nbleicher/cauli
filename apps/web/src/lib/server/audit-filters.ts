export interface AuditFilters {
  action: string;
  actor: string;
  cursor: number | null;
  dateFrom: string;
  dateTo: string;
  entity: string;
  entityId: string;
}

function clean(value: string | null, maxLength = 240) {
  return (value ?? "").trim().slice(0, maxLength);
}

function isoDate(value: string, endOfDay: boolean) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const suffix = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
  const parsed = new Date(`${value}${suffix}`);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

export function parseAuditFilters(url: URL): AuditFilters {
  const rawCursor = Number(url.searchParams.get("cursor"));
  const rawDateFrom = clean(url.searchParams.get("dateFrom"), 10);
  const rawDateTo = clean(url.searchParams.get("dateTo"), 10);
  return {
    action: clean(url.searchParams.get("action"), 120),
    actor: clean(url.searchParams.get("actor"), 36),
    cursor: Number.isSafeInteger(rawCursor) && rawCursor > 0 ? rawCursor : null,
    dateFrom: isoDate(rawDateFrom, false),
    dateTo: isoDate(rawDateTo, true),
    entity: clean(url.searchParams.get("entity"), 80),
    entityId: clean(url.searchParams.get("entityId")),
  };
}

export function filtersToSearchParams(
  filters: AuditFilters,
  cursor?: number | null
) {
  const params = new URLSearchParams();
  if (filters.action) params.set("action", filters.action);
  if (filters.actor) params.set("actor", filters.actor);
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom.slice(0, 10));
  if (filters.dateTo) params.set("dateTo", filters.dateTo.slice(0, 10));
  if (filters.entity) params.set("entity", filters.entity);
  if (filters.entityId) params.set("entityId", filters.entityId);
  if (cursor) params.set("cursor", String(cursor));
  return params;
}
