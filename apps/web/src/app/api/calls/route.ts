import { createCallSchema } from "@calllog/shared";
import { after, NextResponse } from "next/server";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, rateLimitResponse, sanitizeError } from "@/lib/server/http";
import { emitCallStartedMetric } from "@/lib/server/metrics";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;

  const parsed = await parseJson(request, createCallSchema);
  if (parsed.error) return parsed.error;

  const callId = crypto.randomUUID();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(
    "create_attested_call_for_current_user",
    {
      target_call_id: callId,
      target_source_mode: parsed.data.sourceMode,
      target_mic_label: parsed.data.micLabel ?? "",
      target_tab_label: parsed.data.tabLabel ?? "",
      target_title: parsed.data.title ?? null,
      target_recording_attested: parsed.data.recordingAttested,
    }
  );

  if (error) {
    const limited = await rateLimitResponse(error, supabase, "call.create");
    if (limited) return limited;
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  const call = Array.isArray(data) ? data[0] : data;
  // After the primary success path (same placement as audit side effects).
  // Fire-and-forget: metrics must never block or fail Call creation.
  after(() => {
    emitCallStartedMetric({
      callId: call.id,
      profileId: call.owner_id,
      occurredAt: call.started_at,
    });
  });
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
