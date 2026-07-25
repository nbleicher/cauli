import { roleSchema } from "@calllog/shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";

const updateMemberSchema = z.object({ role: roleSchema });

async function hasAnotherAdmin(workspaceId: string, userId: string) {
  const admin = createAdminSupabaseClient();
  const { count } = await admin
    .from("workspace_members")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("role", "admin")
    .neq("user_id", userId);
  return (count ?? 0) > 0;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;
  const { id } = await params;
  const parsed = await parseJson(request, updateMemberSchema);
  if (parsed.error) return parsed.error;

  if (id === auth.user.id && parsed.data.role !== "admin"
    && !await hasAnotherAdmin(auth.member.workspaceId, id)) {
    return NextResponse.json({ error: "The workspace must retain at least one admin" }, { status: 409 });
  }

  const admin = createAdminSupabaseClient();
  const { error } = await admin
    .from("workspace_members")
    .update({ role: parsed.data.role })
    .eq("workspace_id", auth.member.workspaceId)
    .eq("user_id", id);

  if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  return NextResponse.json({ role: parsed.data.role });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;
  const { id } = await params;

  if (id === auth.user.id && !await hasAnotherAdmin(auth.member.workspaceId, id)) {
    return NextResponse.json({ error: "The workspace must retain at least one admin" }, { status: 409 });
  }

  const admin = createAdminSupabaseClient();
  const { error } = await admin
    .from("workspace_members")
    .delete()
    .eq("workspace_id", auth.member.workspaceId)
    .eq("user_id", id);

  if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
