import { redirect } from "next/navigation";
import { LegalAcceptanceForm } from "@/components/LegalAcceptanceForm";
import { PublicFooter } from "@/components/PublicFooter";
import { getAuthContext, requirePageSecondFactor } from "@/lib/server/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function LegalAcceptancePage() {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");
  await requirePageSecondFactor(auth);

  const supabase = await createServerSupabaseClient();
  const { data: documents, error } = await supabase.rpc(
    "required_legal_documents_for_current_user"
  );
  if (error) throw error;
  const requiredDocuments = documents ?? [];
  if (requiredDocuments.length === 0) redirect("/record");

  return (
    <main className="auth-page">
      <section className="auth-panel legal-acceptance-panel">
        <p className="eyebrow">Invitation Activation</p>
        <h1>Review current pilot documents</h1>
        <p>
          Application access remains locked until you accept the exact current
          versions required for your account.
        </p>
        <LegalAcceptanceForm documents={requiredDocuments} />
      </section>
      <PublicFooter />
    </main>
  );
}
