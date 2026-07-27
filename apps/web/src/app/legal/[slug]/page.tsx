import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicFooter } from "@/components/PublicFooter";
import { createServerSupabaseClient } from "@/lib/supabase/server";

interface LegalPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string }>;
}

async function loadLegalVersion(slug: string, requestedVersion?: string) {
  const supabase = await createServerSupabaseClient();
  const { data: document } = await supabase
    .from("legal_documents")
    .select("id, slug, title")
    .eq("slug", slug)
    .maybeSingle();
  if (!document) return null;

  let query = supabase
    .from("legal_document_versions")
    .select(
      "id, version, content_markdown, content_sha256, published_at, effective_at, operator_approved_at"
    )
    .eq("document_id", document.id)
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1);
  if (requestedVersion) query = query.eq("version", requestedVersion);
  const { data: version } = await query.maybeSingle();
  return version ? { document, version } : null;
}

export async function generateMetadata({
  params,
}: LegalPageProps): Promise<Metadata> {
  const legal = await loadLegalVersion((await params).slug);
  return { title: legal?.document.title ?? "Legal" };
}

export default async function LegalPage({
  params,
  searchParams,
}: LegalPageProps) {
  const { slug } = await params;
  const legal = await loadLegalVersion(slug, (await searchParams).version);
  if (!legal) notFound();

  const approved = Boolean(
    legal.version.published_at && legal.version.operator_approved_at
  );
  return (
    <main className="public-policy-page">
      <article className="public-policy-card">
        <Link className="brand public-policy-brand" href="/">
          cauli<span className="brand-dot">.</span>
        </Link>
        <p className="eyebrow">Pilot policy</p>
        <h1>{legal.document.title}</h1>
        <p className={`status-pill ${approved ? "" : "warning"}`}>
          Version {legal.version.version} ·{" "}
          {approved ? "Operator-approved" : "Draft for operator review"}
        </p>
        <p className="policy-hash">
          SHA-256 <code>{legal.version.content_sha256}</code>
        </p>
        <div className="policy-copy">
          {legal.version.content_markdown
            .split(/\n{2,}/)
            .map((paragraph: string) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
        </div>
      </article>
      <PublicFooter />
    </main>
  );
}
