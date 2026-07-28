import { DEFAULT_RETENTION_DAYS } from "@calllog/shared";
import { CallTable } from "@/components/CallTable";
import { PageHeader } from "@/components/PageHeader";
import { ProcessingPoller } from "@/components/ProcessingPoller";
import { listCalls } from "@/lib/server/call-queries";
import { requirePageAuth } from "@/lib/server/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function MyCallsPage() {
  const { user, member } = await requirePageAuth();
  const calls = await listCalls(user.id);

  // Every Workspace Member sees the governing rule, whatever their role. Only
  // an Admin can change it, from Workspace Admin.
  const supabase = await createServerSupabaseClient();
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("retention_days")
    .eq("id", member.workspaceId)
    .single();
  const retentionDays = workspace?.retention_days ?? DEFAULT_RETENTION_DAYS;

  return (
    <main className="page">
      <PageHeader
        title="My Calls"
        description={`Your recordings, transcripts, exports, and completed reviews. This Workspace's Retention Policy deletes every Call ${retentionDays} days after it is recorded.`}
      />
      <ProcessingPoller
        active={calls.some((call) =>
          ["recording", "uploading", "queued", "processing"].includes(
            call.status
          )
        )}
      />
      <CallTable calls={calls} showOwner={false} />
    </main>
  );
}
