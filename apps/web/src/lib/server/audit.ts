import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export interface AuditEventInput {
  workspaceId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, boolean | number | string | null>;
}

export async function recordAuditEvent({
  workspaceId,
  actorId,
  action,
  entityType,
  entityId,
  metadata = {},
}: AuditEventInput) {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.rpc("record_audit_event", {
    target_workspace_id: workspaceId,
    target_actor_id: actorId,
    target_action: action,
    target_entity_type: entityType,
    target_entity_id: entityId,
    target_metadata: metadata,
  });
  if (error) throw error;
  return data as number;
}
