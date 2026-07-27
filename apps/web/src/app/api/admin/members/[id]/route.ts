import { roleSchema } from "@calllog/shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const updateMemberSchema = z
  .object({
    role: roleSchema.optional(),
    status: z.enum(["active", "suspended", "former"]).optional(),
  })
  .refine((value) => Boolean(value.role) !== Boolean(value.status), {
    message: "Provide exactly one member change",
  });

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;
  const { id } = await params;
  const parsed = await parseJson(request, updateMemberSchema);
  if (parsed.error) return parsed.error;

  const supabase = await createServerSupabaseClient();
  const { error } = parsed.data.role
    ? await supabase.rpc("change_workspace_member_role", {
        target_user_id: id,
        target_role: parsed.data.role,
      })
    : await supabase.rpc("set_workspace_member_status", {
        target_user_id: id,
        target_status: parsed.data.status,
      });

  if (error) {
    const status =
      /retain at least one Admin|cannot suspend or remove their own|limited to ten active/i.test(
        error.message
      )
        ? 409
        : 500;
    return NextResponse.json({ error: sanitizeError(error) }, { status });
  }
  return NextResponse.json(parsed.data);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;
  const { id } = await params;

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_workspace_member_status", {
    target_user_id: id,
    target_status: "former",
  });

  if (error) {
    const status = /cannot suspend or remove their own/i.test(error.message)
      ? 409
      : 500;
    return NextResponse.json({ error: sanitizeError(error) }, { status });
  }
  return new NextResponse(null, { status: 204 });
}
