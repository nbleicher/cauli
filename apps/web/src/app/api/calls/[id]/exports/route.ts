import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { authorizeCall } from "@/lib/server/calls";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { sanitizeError } from "@/lib/server/http";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;
  const { id } = await params;
  const call = await authorizeCall(auth, id, "view");
  if (!call) return NextResponse.json({ error: "Call not found" }, { status: 404 });

  if (call.row.wav_path) {
    return NextResponse.json({ status: "complete" });
  }

  const admin = createAdminSupabaseClient();
  const { data: exportJob, error: exportError } = await admin
    .from("export_jobs")
    .insert({
      call_id: id,
      requested_by: auth.user.id,
      format: "wav",
    })
    .select("id")
    .single();

  if (exportError) {
    return NextResponse.json({ error: sanitizeError(exportError) }, { status: 500 });
  }

  const { error: jobError } = await admin.from("processing_jobs").insert({
    workspace_id: call.access.workspaceId,
    call_id: id,
    kind: "generate_wav",
    status: "queued",
    idempotency_key: `wav:${id}`,
    payload: { exportJobId: exportJob.id },
  });

  if (jobError && jobError.code !== "23505") {
    return NextResponse.json({ error: sanitizeError(jobError) }, { status: 500 });
  }
  return NextResponse.json({ status: "queued", exportJobId: exportJob.id }, { status: 202 });
}
