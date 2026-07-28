import type { Role } from "@calllog/shared";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { WorkspaceAdmin } from "@/components/WorkspaceAdmin";
import { requirePageAuth } from "@/lib/server/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

interface ProfileRelation {
  email: string;
  display_name: string;
}

function firstProfile(value: unknown): ProfileRelation | null {
  if (Array.isArray(value))
    return (value[0] as ProfileRelation | undefined) ?? null;
  return value as ProfileRelation | null;
}

export default async function WorkspaceAdminPage() {
  const { user, member } = await requirePageAuth();
  if (member.role !== "admin") redirect("/record");
  const supabase = await createServerSupabaseClient();

  const [{ data: memberships }, { data: invites }] = await Promise.all([
    supabase
      .from("workspace_members")
      .select(
        `
        user_id, role, status, joined_at,
        profile:profiles!workspace_members_user_id_fkey(email, display_name)
      `
      )
      .eq("workspace_id", member.workspaceId)
      .order("joined_at"),
    supabase
      .from("workspace_invites")
      .select("id, email, role, expires_at")
      .eq("workspace_id", member.workspaceId)
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false }),
  ]);

  return (
    <main className="page page-narrow">
      <PageHeader
        title="Workspace Admin"
        description="Invite Workspace Members and control access."
      />
      <WorkspaceAdmin
        currentUserId={user.id}
        members={(memberships ?? []).map((membership) => {
          const profile = firstProfile(membership.profile);
          return {
            userId: membership.user_id,
            email: profile?.email ?? "",
            displayName: profile?.display_name ?? "",
            role: membership.role as Role,
            status: membership.status as "active" | "suspended" | "former",
            joinedAt: membership.joined_at,
            // Role-aware MFA state becomes application-owned in ticket #14;
            // the normal web runtime deliberately has no Auth-admin secret.
            mfaEnabled: false,
          };
        })}
        invites={(invites ?? []).map((invite) => ({
          id: invite.id,
          email: invite.email,
          role: invite.role as Role,
          expiresAt: invite.expires_at,
        }))}
      />
    </main>
  );
}
