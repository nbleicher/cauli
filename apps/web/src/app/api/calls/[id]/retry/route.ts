import { NextResponse } from "next/server";
import { authorizeCall } from "@/lib/server/calls";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { rateLimitResponse, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

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

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("request_call_retry", {
    target_call_id: id,
  });

  if (error) {
    const limited = await rateLimitResponse(error, supabase, "call.reprocess");
    if (limited) return limited;
    return NextResponse.json(
      {
        error: sanitizeError(error),
      },
      { status: 500 }
    );
  }
  return NextResponse.json({ status: "queued" });
}
