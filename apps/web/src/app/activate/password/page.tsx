import { redirect } from "next/navigation";
import { PasswordSetupForm } from "@/components/PasswordSetupForm";
import { PublicFooter } from "@/components/PublicFooter";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function ActivationPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const inviteId = (await searchParams).invite;
  if (!inviteId) redirect("/login?error=invalid_invitation");
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?error=invalid_invitation");
  const { data: invitationRole, error: invitationError } = await supabase.rpc(
    "pending_invitation_role",
    { target_invite_id: inviteId }
  );
  if (invitationError || !invitationRole) {
    redirect("/login?error=invalid_invitation");
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <p className="eyebrow">Invitation Activation</p>
        <h1>Create your password</h1>
        <p>Use this password for routine Cauli sign-in.</p>
        <PasswordSetupForm
          inviteId={inviteId}
          mfaRequired={
            invitationRole === "manager" || invitationRole === "admin"
          }
        />
      </section>
      <PublicFooter />
    </main>
  );
}
