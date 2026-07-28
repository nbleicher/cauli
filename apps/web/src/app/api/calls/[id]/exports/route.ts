import { NextResponse } from "next/server";
import { authorizeCall } from "@/lib/server/calls";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { sanitizeError } from "@/lib/server/http";
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

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("request_wav_export", {
    target_call_id: id,
  });

  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  const result = data as { status: string; exportJobId?: string };
  return NextResponse.json(result, {
    status: result.status === "complete" ? 200 : 202,
  });
}
