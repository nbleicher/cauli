import { AppShell } from "@/components/AppShell";
import { requirePageAuth } from "@/lib/server/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, member } = await requirePageAuth();
  let needsAttentionCount = 0;
  if (member.role === "admin") {
    const supabase = await createServerSupabaseClient();
    const { count } = await supabase
      .from("processing_jobs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", member.workspaceId)
      .eq("status", "failed");
    needsAttentionCount = count ?? 0;
  }
  return (
    <AppShell
      email={user.email}
      needsAttentionCount={needsAttentionCount}
      role={member.role}
    >
      {children}
    </AppShell>
  );
}
