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

  const [
    { data: memberships },
    { data: invites },
    { data: mfaStatusResult },
    { data: recoveryLockouts },
  ] = await Promise.all([
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
    supabase.functions.invoke("identity-admin", {
      body: { action: "list_mfa_status" },
    }),
    supabase.rpc("workspace_recovery_lockouts"),
  ]);
  const mfaStatuses = new Map(
    (
      (
        mfaStatusResult as {
          statuses?: { userId: string; enabled: boolean }[];
        } | null
      )?.statuses ?? []
    ).map((status) => [status.userId, status.enabled])
  );

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
            mfaEnabled: mfaStatuses.get(membership.user_id) ?? false,
          };
        })}
        recoveryLockouts={(
          (recoveryLockouts ?? []) as { user_id: string }[]
        ).map((lockout) => lockout.user_id)}
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
