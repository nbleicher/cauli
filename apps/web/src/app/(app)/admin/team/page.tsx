import type { Role } from "@calllog/shared";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { TeamAdmin } from "@/components/TeamAdmin";
import { requirePageAuth } from "@/lib/server/auth";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";

interface ProfileRelation {
  email: string;
  display_name: string;
}

function firstProfile(value: unknown): ProfileRelation | null {
  if (Array.isArray(value)) return (value[0] as ProfileRelation | undefined) ?? null;
  return value as ProfileRelation | null;
}

export default async function TeamAdminPage() {
  const { user, member } = await requirePageAuth();
  if (member.role !== "admin") redirect("/record");
  const supabase = await createServerSupabaseClient();

  const [{ data: memberships }, { data: invites }] = await Promise.all([
    supabase
      .from("workspace_members")
      .select(`
        user_id, role, joined_at,
        profile:profiles!workspace_members_user_id_fkey(email, display_name)
      `)
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

  // Which members have a verified second factor. Needs the service role, so it
  // is resolved here rather than in the client component.
  const adminClient = createAdminSupabaseClient();
  const mfaEntries = await Promise.all(
    (memberships ?? []).map(async (membership) => {
      const { data } = await adminClient.auth.admin.mfa.listFactors({
        userId: membership.user_id,
      });
      const enabled = (data?.factors ?? []).some((factor) => factor.status === "verified");
      return [membership.user_id, enabled] as const;
    }),
  );
  const mfaByUser = new Map(mfaEntries);

  return (
    <main className="page page-narrow">
      <PageHeader
        title="Team Admin"
        description="Invite teammates and control workspace access."
      />
      <TeamAdmin
        currentUserId={user.id}
        members={(memberships ?? []).map((membership) => {
          const profile = firstProfile(membership.profile);
          return {
            userId: membership.user_id,
            email: profile?.email ?? "",
            displayName: profile?.display_name ?? "",
            role: membership.role as Role,
            joinedAt: membership.joined_at,
            mfaEnabled: mfaByUser.get(membership.user_id) ?? false,
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
