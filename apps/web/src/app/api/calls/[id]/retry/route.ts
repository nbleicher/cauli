import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { authorizeCall } from "@/lib/server/calls";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { sanitizeError } from "@/lib/server/http";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;
  const { id } = await params;
  const call = await authorizeCall(auth, id, "view");
  if (!call)
    return NextResponse.json({ error: "Call not found" }, { status: 404 });
  if (call.row.status !== "failed") {
    return NextResponse.json(
      { error: "Only failed calls can be retried" },
      { status: 409 }
    );
  }

  const admin = createAdminSupabaseClient();
  const { error: callError } = await admin
    .from("calls")
    .update({ status: "queued", error_message: null })
    .eq("id", id);
  const { error: jobError } = await admin.from("processing_jobs").upsert(
    {
      workspace_id: call.access.workspaceId,
      call_id: id,
      kind: "process_recording",
      status: "queued",
      idempotency_key: `process:${id}`,
      attempts: 0,
      next_attempt_at: new Date().toISOString(),
      error_message: null,
      error_category: null,
      error_chunk_index: null,
      provider_generation_id: null,
    },
    { onConflict: "idempotency_key" }
  );

  if (callError || jobError) {
    return NextResponse.json(
      {
        error: sanitizeError(callError ?? jobError),
      },
      { status: 500 }
    );
  }
  return NextResponse.json({ status: "queued" });
}
