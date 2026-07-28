import { redirect } from "next/navigation";
import { CallTable } from "@/components/CallTable";
import { PageHeader } from "@/components/PageHeader";
import { ProcessingPoller } from "@/components/ProcessingPoller";
import { ReviewQueue } from "@/components/ReviewQueue";
import { listCalls } from "@/lib/server/call-queries";
import { requirePageAuth } from "@/lib/server/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function WorkspaceCallsPage() {
  const { user, member } = await requirePageAuth();
  if (member.role === "member") redirect("/calls");
  const calls = await listCalls();
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
          ["recording", "uploading", "queued", "processing"].includes(
            call.status
          )
        )}
      />
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
      <CallTable calls={calls} showOwner showReviewAssignee />
    </main>
  );
}
