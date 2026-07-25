import { createCallSchema } from "@calllog/shared";
import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";

export async function POST(request: Request) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;

  const parsed = await parseJson(request, createCallSchema);
  if (parsed.error) return parsed.error;

  const callId = crypto.randomUUID();
  const chunkPrefix = `${auth.member.workspaceId}/${callId}/chunks`;
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from("calls")
    .insert({
      id: callId,
      workspace_id: auth.member.workspaceId,
      owner_id: auth.user.id,
      source_mode: parsed.data.sourceMode,
      status: "recording",
      chunk_prefix: chunkPrefix,
      mic_label: parsed.data.micLabel ?? "",
      tab_label: parsed.data.tabLabel ?? "",
    })
    .select("id, workspace_id, status, started_at, chunk_prefix")
    .single();

  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  return NextResponse.json({
    callId: data.id,
    workspaceId: data.workspace_id,
    status: data.status,
    startedAt: data.started_at,
    storagePrefix: data.chunk_prefix,
  }, { status: 201 });
}
