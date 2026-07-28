import { finalizeCallSchema } from "@calllog/shared";
import { NextResponse } from "next/server";
import { authorizeCall } from "@/lib/server/calls";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;
  const { id } = await params;

  if (!(await authorizeCall(auth, id, "own"))) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 });
  }

  const parsed = await parseJson(request, finalizeCallSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("finalize_owned_call", {
    target_call_id: id,
    final_chunk_sequence: body.finalChunkSequence,
    target_duration_ms: body.durationMs,
    target_mime_type: body.mimeType,
    target_source_mode: body.sourceMode,
    target_mic_label: body.micLabel ?? "",
    target_tab_label: body.tabLabel ?? "",
    target_degraded_intervals: body.degradedIntervals,
  });

  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  return NextResponse.json({ call: data });
}
