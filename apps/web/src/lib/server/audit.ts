import { createServerSupabaseClient } from "@/lib/supabase/server";

export interface AuditEventInput {
  workspaceId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, boolean | number | string | null>;
}

export async function recordAuditEvent({
  action,
  metadata = {},
}: AuditEventInput) {
  if (action !== "audit.export.created") {
    throw new Error("The web principal cannot write arbitrary Audit Events");
  }
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(
    "record_audit_export_for_current_admin",
    {
      exported_rows: Number(metadata.exported_rows ?? 0),
      filters_applied: Number(metadata.filters_applied ?? 0),
    }
  );
  if (error) throw error;
  return data as number;
}
