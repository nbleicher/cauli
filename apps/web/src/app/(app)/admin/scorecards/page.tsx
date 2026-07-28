import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { ScorecardAdmin } from "@/components/ScorecardAdmin";
import { requirePageAuth } from "@/lib/server/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function ScorecardAdminPage() {
  const { member } = await requirePageAuth();
  if (member.role !== "admin") redirect("/record");
  const supabase = await createServerSupabaseClient();

  const { data: template } = await supabase
    .from("scorecard_templates")
    .select("id, name")
    .eq("workspace_id", member.workspaceId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: version } = template
    ? await supabase
        .from("scorecard_versions")
        .select("id, version")
        .eq("template_id", template.id)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  const { data: publishedVersions } = template
    ? await supabase
        .from("scorecard_versions")
        .select("id, version, name")
        .eq("template_id", template.id)
        .order("version", { ascending: false })
    : { data: [] };

  const { data: comparisonSets } = template
    ? await supabase
        .from("scorecard_comparison_sets")
        .select("id")
        .eq("template_id", template.id)
        .is("revoked_at", null)
    : { data: [] };
  const comparisonSetIds = (comparisonSets ?? []).map(
    (comparisonSet) => comparisonSet.id
  );
  const { data: comparisonMemberships } = comparisonSetIds.length
    ? await supabase
        .from("scorecard_comparison_set_versions")
        .select("comparison_set_id, scorecard_version_id")
        .in("comparison_set_id", comparisonSetIds)
        .eq("active", true)
    : { data: [] };

  const { data: categories } = version
    ? await supabase
        .from("scorecard_categories")
        .select("id, name, position")
        .eq("version_id", version.id)
        .order("position")
    : { data: [] };

  const categoryIds = (categories ?? []).map((category) => category.id);
  const { data: criteria } = categoryIds.length
    ? await supabase
        .from("scorecard_criteria")
        .select("category_id, label, description, weight, required, position")
        .in("category_id", categoryIds)
        .order("position")
    : { data: [] };

  return (
    <main className="page page-narrow">
      <PageHeader
        title="Scorecards"
        description="Publish weighted QA criteria. Existing reviews keep their original version."
      />
      <ScorecardAdmin
        templateId={template?.id ?? null}
        initialName={template?.name ?? ""}
        initialVersion={version?.version ?? 0}
        publishedVersions={publishedVersions ?? []}
        comparisonSets={(comparisonSets ?? []).map((comparisonSet) => ({
          id: comparisonSet.id,
          versionIds: (comparisonMemberships ?? [])
            .filter(
              (membership) => membership.comparison_set_id === comparisonSet.id
            )
            .map((membership) => membership.scorecard_version_id),
        }))}
        initialCategories={(categories ?? []).map((category) => ({
          name: category.name,
          criteria: (criteria ?? [])
            .filter((criterion) => criterion.category_id === category.id)
            .map((criterion) => ({
              label: criterion.label,
              description: criterion.description,
              weight: criterion.weight,
              required: criterion.required,
            })),
        }))}
      />
    </main>
  );
}
