import { renameCallSchema } from "@calllog/shared";
import { NextResponse } from "next/server";
import { authorizeCall } from "@/lib/server/calls";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;
  const parsed = await parseJson(request, renameCallSchema);
  if (parsed.error) return parsed.error;

  const { id } = await params;
  const call = await authorizeCall(auth, id, "own");
  if (!call)
    return NextResponse.json({ error: "Call not found" }, { status: 404 });

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("rename_owned_call", {
    target_call_id: id,
    target_title: parsed.data.title,
  });
  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 422 });
  }
  const renamed = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({ title: renamed.title });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;
  const { id } = await params;
  const call = await authorizeCall(auth, id, "delete");
  if (!call)
    return NextResponse.json({ error: "Call not found" }, { status: 404 });

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("request_call_deletion", {
    target_call_id: id,
  });

  if (error) {
    return NextResponse.json(
      {
        error: sanitizeError(error),
      },
      { status: 500 }
    );
  }
  return new NextResponse(null, { status: 204 });
}
