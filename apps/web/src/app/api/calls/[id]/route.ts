import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { authorizeCall } from "@/lib/server/calls";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { sanitizeError } from "@/lib/server/http";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;
  const { id } = await params;
  const call = await authorizeCall(auth, id, "delete");
  if (!call) return NextResponse.json({ error: "Call not found" }, { status: 404 });

  const admin = createAdminSupabaseClient();
  const now = new Date().toISOString();
  const { error: callError } = await admin
    .from("calls")
    .update({ deleted_at: now })
    .eq("id", id);

  const { error: jobError } = await admin.from("processing_jobs").insert({
    workspace_id: call.access.workspaceId,
    call_id: id,
    kind: "delete_call",
    status: "queued",
    idempotency_key: `delete:${id}`,
  });

  if (callError || (jobError && jobError.code !== "23505")) {
    return NextResponse.json({
      error: sanitizeError(callError ?? jobError),
    }, { status: 500 });
  }
  return new NextResponse(null, { status: 204 });
}
