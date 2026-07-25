import {
  canDeleteCall,
  canReviewCall,
  canViewCall,
  type CallAccessSubject,
} from "@calllog/shared";
import type { AuthContext } from "@/lib/server/auth";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export async function getCallAccessSubject(callId: string) {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from("calls")
    .select("id, workspace_id, owner_id, status, source_path, mp3_path, wav_path, deleted_at")
    .eq("id", callId)
    .maybeSingle();

  if (error) throw error;
  if (!data || data.deleted_at) return null;
  return {
    access: {
      id: data.id,
      workspaceId: data.workspace_id,
      ownerId: data.owner_id,
    } satisfies CallAccessSubject,
    row: data,
  };
}

export async function authorizeCall(
  context: AuthContext,
  callId: string,
  action: "view" | "delete" | "review" | "own",
) {
  const result = await getCallAccessSubject(callId);
  if (!result) return null;

  const allowed = action === "view"
    ? canViewCall(context.member, result.access)
    : action === "delete"
      ? canDeleteCall(context.member, result.access)
      : action === "review"
        ? canReviewCall(context.member, result.access)
        : context.member.workspaceId === result.access.workspaceId
          && context.user.id === result.access.ownerId;

  return allowed ? result : null;
}
