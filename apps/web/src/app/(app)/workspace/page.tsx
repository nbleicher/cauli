import { ACTIVE_CALL_STATUSES } from "@calllog/shared";
import { redirect } from "next/navigation";
import { CallFilters } from "@/components/CallFilters";
import { CallPagination } from "@/components/CallPagination";
import { CallTable } from "@/components/CallTable";
import { PageHeader } from "@/components/PageHeader";
import { ProcessingPoller } from "@/components/ProcessingPoller";
import { ReviewQueue } from "@/components/ReviewQueue";
import {
  hasActiveCallFilters,
  parseCallFilters,
  type SearchParams,
} from "@/lib/server/call-filter-params";
import { listCallsPage } from "@/lib/server/call-queries";
import { requirePageAuth } from "@/lib/server/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function WorkspaceCallsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user, member } = await requirePageAuth();
  if (member.role === "member") redirect("/calls");
  const params = await searchParams;
  const cursor = typeof params.cursor === "string" ? params.cursor : null;
  const { calls, nextCursor } = await listCallsPage(
    parseCallFilters(params, { userId: user.id, ownedOnly: false }),
    cursor
  );
  const supabase = await createServerSupabaseClient();
  const { data: eligibleMembers } = await supabase
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", member.workspaceId)
    .eq("status", "active")
    .in("role", ["manager", "admin"]);
  const eligibleMemberIds = (eligibleMembers ?? []).map(
    (eligibleMember) => eligibleMember.user_id
  );
  const { data: eligibleProfiles } = eligibleMemberIds.length
    ? await supabase
        .from("profiles")
        .select("id, display_name, email")
        .in("id", eligibleMemberIds)
    : { data: [] };

  return (
    <main className="page">
      <PageHeader
        title="Workspace Calls"
        description="Review every call recorded in this workspace."
      />
      <ProcessingPoller
        active={calls.some((call) =>
          ACTIVE_CALL_STATUSES.includes(call.status)
        )}
      />
      <CallFilters showOwner />
      <ReviewQueue
        calls={calls}
        currentUserId={user.id}
        role={member.role}
        assignees={(eligibleMembers ?? []).map((eligibleMember) => {
          const profile = (eligibleProfiles ?? []).find(
            (eligibleProfile) => eligibleProfile.id === eligibleMember.user_id
          );
          return {
            id: eligibleMember.user_id,
            name:
              profile?.display_name ||
              profile?.email ||
              eligibleMember.user_id.slice(0, 8),
            role: eligibleMember.role as "manager" | "admin",
          };
        })}
      />
      <CallTable
        calls={calls}
        showOwner
        showReviewAssignee
        filtered={hasActiveCallFilters(params)}
      />
      <CallPagination nextCursor={nextCursor} shown={calls.length} />
    </main>
  );
}
