import { NextResponse } from "next/server";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { sanitizeError } from "@/lib/server/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

// Removes every enrolled second factor for a member who has lost their
// authenticator. They can sign in with their password alone afterwards, so this
// is a privileged action: admin only, and requireApiAuth already refuses an
// aal1 session when the acting admin has a factor of their own.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;
  const { id } = await params;

  const admin = createAdminSupabaseClient();

  // The MFA admin API is not scoped by workspace, so membership has to be
  // checked explicitly — otherwise an admin here could clear factors for a
  // user in an unrelated workspace.
  const { data: membership, error: membershipError } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", auth.member.workspaceId)
    .eq("user_id", id)
    .maybeSingle();
  if (membershipError) {
    return NextResponse.json({ error: sanitizeError(membershipError) }, { status: 500 });
  }
  if (!membership) {
    return NextResponse.json({ error: "Not a member of this workspace" }, { status: 404 });
  }

  const { data: factors, error: listError } = await admin.auth.admin.mfa.listFactors({ userId: id });
  if (listError) {
    return NextResponse.json({ error: sanitizeError(listError) }, { status: 500 });
  }

  let removed = 0;
  for (const factor of factors?.factors ?? []) {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ userId: id, id: factor.id });
    if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    removed += 1;
  }

  return NextResponse.json({ removed });
}
