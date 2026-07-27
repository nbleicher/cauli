import { NextResponse } from "next/server";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Removes every enrolled second factor for a member who has lost their
// authenticator. They can sign in with their password alone afterwards, so this
// is a privileged action: admin only, and requireApiAuth already refuses an
// aal1 session when the acting admin has a factor of their own.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;
  const { id } = await params;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.functions.invoke("identity-admin", {
    body: { action: "reset_mfa", userId: id },
  });
  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  return NextResponse.json(data);
}
