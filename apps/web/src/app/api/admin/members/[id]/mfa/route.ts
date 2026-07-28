import { NextResponse } from "next/server";
import {
  isAuthError,
  requireApiAuth,
  requireFreshMfa,
} from "@/lib/server/auth";
import { sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Removes every enrolled second factor for a member who has lost their
// authenticator. A Member can sign in with their password alone afterwards and
// a privileged Role must enroll again before regaining access, so this is a
// privileged action: admin only, and requireApiAuth already refuses an aal1
// session when the acting admin has a factor of their own.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;
  const stale = await requireFreshMfa();
  if (stale) return stale;
  const { id } = await params;
  // The identity endpoint refuses this too; answering here keeps the denial a
  // 403 instead of a failed Edge Function invocation.
  if (id === auth.user.id) {
    return NextResponse.json(
      { error: "Another Workspace Admin must reset your authenticator" },
      { status: 403 }
    );
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.functions.invoke("identity-admin", {
    body: { action: "reset_mfa", userId: id },
  });
  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  return NextResponse.json(data);
}
