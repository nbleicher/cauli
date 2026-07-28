import { createCallSchema } from "@calllog/shared";
import { NextResponse } from "next/server";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, rateLimitResponse, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;

  const parsed = await parseJson(request, createCallSchema);
  if (parsed.error) return parsed.error;

  const callId = crypto.randomUUID();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("create_call_for_current_user", {
    target_call_id: callId,
    target_source_mode: parsed.data.sourceMode,
    target_mic_label: parsed.data.micLabel ?? "",
    target_tab_label: parsed.data.tabLabel ?? "",
  });

  if (error) {
    const limited = await rateLimitResponse(error, supabase, "call.create");
    if (limited) return limited;
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  const call = Array.isArray(data) ? data[0] : data;
  return NextResponse.json(
    {
      callId: call.id,
      workspaceId: call.workspace_id,
      status: call.status,
      startedAt: call.started_at,
      storagePrefix: call.chunk_prefix,
    },
    { status: 201 }
  );
}
