import { AppShell } from "@/components/AppShell";
import { requirePageAuth } from "@/lib/server/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, member } = await requirePageAuth();
  let needsAttentionCount = 0;
  let breakGlassNoticeCount = 0;
  if (member.role === "admin") {
    const supabase = await createServerSupabaseClient();
    const [{ count: attentionCount }, { count: noticeCount }] =
      await Promise.all([
        supabase
          .from("processing_jobs")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", member.workspaceId)
          .eq("status", "failed"),
        supabase
          .from("workspace_admin_notifications")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", member.workspaceId)
          .is("read_at", null),
      ]);
    needsAttentionCount = attentionCount ?? 0;
    breakGlassNoticeCount = noticeCount ?? 0;
  }
  return (
    <AppShell
      email={user.email}
      needsAttentionCount={needsAttentionCount}
      breakGlassNoticeCount={breakGlassNoticeCount}
      role={member.role}
    >
      {children}
    </AppShell>
  );
}
