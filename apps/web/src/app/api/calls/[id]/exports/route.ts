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

  if (call.row.wav_path) {
    return NextResponse.json({ status: "complete" });
  }

  const admin = createAdminSupabaseClient();
  const { data: existingExport, error: existingError } = await admin
    .from("export_jobs")
    .select("id, status")
    .eq("call_id", id)
    .eq("format", "wav")
    .maybeSingle();
  if (existingError) {
    return NextResponse.json(
      { error: sanitizeError(existingError) },
      { status: 500 }
    );
  }
  if (existingExport) {
    if (existingExport.status === "failed") {
      const [{ error: resetExportError }, { error: resetJobError }] =
        await Promise.all([
          admin
            .from("export_jobs")
            .update({
              status: "queued",
              error_message: null,
            })
            .eq("id", existingExport.id),
          admin.from("processing_jobs").upsert(
            {
              workspace_id: call.access.workspaceId,
              call_id: id,
              kind: "generate_wav",
              status: "queued",
              idempotency_key: `wav:${id}`,
              payload: { exportJobId: existingExport.id },
              attempts: 0,
              next_attempt_at: new Date().toISOString(),
              error_message: null,
            },
            { onConflict: "idempotency_key" }
          ),
        ]);
      if (resetExportError || resetJobError) {
        return NextResponse.json(
          {
            error: sanitizeError(resetExportError ?? resetJobError),
          },
          { status: 500 }
        );
      }
      return NextResponse.json(
        {
          status: "queued",
          exportJobId: existingExport.id,
        },
        { status: 202 }
      );
    }
    return NextResponse.json(
      {
        status: existingExport.status,
        exportJobId: existingExport.id,
      },
      {
        status: existingExport.status === "complete" ? 200 : 202,
      }
    );
  }

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
    return NextResponse.json(
      { error: sanitizeError(exportError) },
      { status: 500 }
    );
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
    return NextResponse.json(
      { error: sanitizeError(jobError) },
      { status: 500 }
    );
  }
  return NextResponse.json(
    { status: "queued", exportJobId: exportJob.id },
    { status: 202 }
  );
}
