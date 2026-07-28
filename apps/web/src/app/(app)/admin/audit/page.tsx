import { Download, Filter } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { formatDate } from "@/lib/format";
import {
  filtersToSearchParams,
  parseAuditFilters,
} from "@/lib/server/audit-filters";
import { requirePageAuth } from "@/lib/server/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

interface AuditEventRow {
  id: number;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

const PAGE_SIZE = 50;

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { member } = await requirePageAuth();
  if (member.role !== "admin") redirect("/record");

  const rawParams = await searchParams;
  const url = new URL("https://audit.local");
  for (const [key, value] of Object.entries(rawParams)) {
    if (typeof value === "string") url.searchParams.set(key, value);
  }
  const filters = parseAuditFilters(url);

  const supabase = await createServerSupabaseClient();
  let query = supabase
    .from("audit_events")
    .select(
      "id, actor_id, action, entity_type, entity_id, metadata, created_at"
    )
    .eq("workspace_id", member.workspaceId)
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1);

  if (filters.cursor) query = query.lt("id", filters.cursor);
  if (filters.action) query = query.eq("action", filters.action);
  if (filters.actor) query = query.eq("actor_id", filters.actor);
  if (filters.dateFrom) query = query.gte("created_at", filters.dateFrom);
  if (filters.dateTo) query = query.lte("created_at", filters.dateTo);
  if (filters.entity) query = query.eq("entity_type", filters.entity);
  if (filters.entityId) query = query.eq("entity_id", filters.entityId);

  const { data, error } = await query;
  if (error) throw error;
  const fetched = (data ?? []) as AuditEventRow[];
  const hasNext = fetched.length > PAGE_SIZE;
  const events = fetched.slice(0, PAGE_SIZE);
  const exportQuery = filtersToSearchParams(filters);

  return (
    <main className="page">
      <PageHeader
        title="Audit Log"
        description="Immutable, content-free evidence of privileged and destructive actions."
      />

      <form className="audit-filters" method="get">
        <label>
          From
          <input
            type="date"
            name="dateFrom"
            defaultValue={filters.dateFrom.slice(0, 10)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            name="dateTo"
            defaultValue={filters.dateTo.slice(0, 10)}
          />
        </label>
        <label>
          Actor ID
          <input name="actor" defaultValue={filters.actor} />
        </label>
        <label>
          Action
          <input
            name="action"
            defaultValue={filters.action}
            placeholder="workspace.invite.created"
          />
        </label>
        <label>
          Entity
          <input
            name="entity"
            defaultValue={filters.entity}
            placeholder="workspace_invite"
          />
        </label>
        <label>
          Entity ID
          <input name="entityId" defaultValue={filters.entityId} />
        </label>
        <div className="audit-filter-actions">
          <button type="submit">
            <Filter size={16} />
            Apply filters
          </button>
          <Link
            className="button button-secondary"
            href={`/api/admin/audit/export?${exportQuery.toString()}`}
          >
            <Download size={16} />
            Export CSV
          </Link>
        </div>
      </form>

      {events.length === 0 ? (
        <section className="empty-state">
          <h2>No matching Audit Events</h2>
          <p>Change the filters or complete an audited action.</p>
        </section>
      ) : (
        <>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Safe metadata</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>{formatDate(event.created_at)}</td>
                    <td className="mono">
                      {event.actor_id?.slice(0, 8) ?? "system"}
                    </td>
                    <td className="mono">{event.action}</td>
                    <td>
                      <div className="table-primary">
                        <strong>{event.entity_type}</strong>
                        <span className="mono">{event.entity_id}</span>
                      </div>
                    </td>
                    <td className="mono">{JSON.stringify(event.metadata)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasNext ? (
            <nav className="audit-pagination" aria-label="Audit pagination">
              <Link
                className="button button-secondary"
                href={`/admin/audit?${filtersToSearchParams(
                  filters,
                  events.at(-1)?.id
                ).toString()}`}
              >
                Older events
              </Link>
            </nav>
          ) : null}
        </>
      )}
    </main>
  );
}
