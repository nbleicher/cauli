import { finalizeCallSchema } from "@calllog/shared";
import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { authorizeCall } from "@/lib/server/calls";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;
  const { id } = await params;

  if (!await authorizeCall(auth, id, "own")) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 });
  }

  const parsed = await parseJson(request, finalizeCallSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.rpc("finalize_call", {
    target_call_id: id,
    final_chunk_sequence: body.finalChunkSequence,
    target_duration_ms: body.durationMs,
    target_mime_type: body.mimeType,
    target_source_mode: body.sourceMode,
    target_mic_label: body.micLabel ?? "",
    target_tab_label: body.tabLabel ?? "",
  });

  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  return NextResponse.json({ call: data });
}
