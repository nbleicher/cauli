import { NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/server/audit";
import { parseAuditFilters } from "@/lib/server/audit-filters";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const EXPORT_LIMIT = 10_000;

function csvCell(value: unknown) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const formulaSafe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${formulaSafe.replaceAll('"', '""')}"`;
}

export async function GET(request: Request) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;

  const filters = parseAuditFilters(new URL(request.url));
  const supabase = await createServerSupabaseClient();
  let query = supabase
    .from("audit_events")
    .select(
      "id, actor_id, action, entity_type, entity_id, metadata, created_at"
    )
    .eq("workspace_id", auth.member.workspaceId)
    .order("id", { ascending: false })
    .limit(EXPORT_LIMIT);

  if (filters.action) query = query.eq("action", filters.action);
  if (filters.actor) query = query.eq("actor_id", filters.actor);
  if (filters.dateFrom) query = query.gte("created_at", filters.dateFrom);
  if (filters.dateTo) query = query.lte("created_at", filters.dateTo);
  if (filters.entity) query = query.eq("entity_type", filters.entity);
  if (filters.entityId) query = query.eq("entity_id", filters.entityId);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }

  const rows = data ?? [];
  const csv = [
    [
      "id",
      "created_at",
      "actor_id",
      "action",
      "entity_type",
      "entity_id",
      "metadata",
    ]
      .map(csvCell)
      .join(","),
    ...rows.map((event) =>
      [
        event.id,
        event.created_at,
        event.actor_id ?? "",
        event.action,
        event.entity_type,
        event.entity_id,
        event.metadata,
      ]
        .map(csvCell)
        .join(",")
    ),
  ].join("\r\n");

  try {
    await recordAuditEvent({
      workspaceId: auth.member.workspaceId,
      actorId: auth.user.id,
      action: "audit.export.created",
      entityType: "workspace",
      entityId: auth.member.workspaceId,
      metadata: {
        exported_rows: rows.length,
        filters_applied: [
          filters.action,
          filters.actor,
          filters.dateFrom,
          filters.dateTo,
          filters.entity,
          filters.entityId,
        ].filter(Boolean).length,
      },
    });
  } catch (auditError) {
    return NextResponse.json(
      { error: sanitizeError(auditError) },
      { status: 500 }
    );
  }

  return new NextResponse(csv, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="cauli-audit-events.csv"',
      "Content-Type": "text/csv; charset=utf-8",
    },
  });
}
