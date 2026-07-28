import { redirect } from "next/navigation";
import { PasswordSetupForm } from "@/components/PasswordSetupForm";
import { PublicFooter } from "@/components/PublicFooter";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function PasswordResetPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?error=invalid_reset");

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <p className="eyebrow">Account recovery</p>
        <h1>Choose a new password</h1>
        <PasswordSetupForm reset />
      </section>
      <PublicFooter />
    </main>
  );
}
