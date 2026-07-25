import { AccountSecurity } from "@/components/AccountSecurity";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAuth } from "@/lib/server/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function AccountPage() {
  await requirePageAuth();

  // Resolved on the server so the page renders in its final state — no
  // "is MFA on?" flash while a client effect fetches.
  const supabase = await createServerSupabaseClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const verifiedFactorId = factors?.totp?.find((f) => f.status === "verified")?.id ?? null;

  return (
    <main className="page page-narrow">
      <PageHeader
        title="Account"
        description="Manage how you sign in to cauli."
      />
      <AccountSecurity initialFactorId={verifiedFactorId} />
    </main>
  );
}
