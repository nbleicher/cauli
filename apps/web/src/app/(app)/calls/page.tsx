import { ACTIVE_CALL_STATUSES, DEFAULT_RETENTION_DAYS } from "@calllog/shared";
import { CallFilters } from "@/components/CallFilters";
import { CallPagination } from "@/components/CallPagination";
import { CallTable } from "@/components/CallTable";
import { PageHeader } from "@/components/PageHeader";
import { ProcessingPoller } from "@/components/ProcessingPoller";
import {
  hasActiveCallFilters,
  parseCallFilters,
  type SearchParams,
} from "@/lib/server/call-filter-params";
import { listCallsPage } from "@/lib/server/call-queries";
import { requirePageAuth } from "@/lib/server/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function MyCallsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user, member } = await requirePageAuth();
  const params = await searchParams;
  const cursor = typeof params.cursor === "string" ? params.cursor : null;
  const { calls, nextCursor } = await listCallsPage(
    parseCallFilters(params, { userId: user.id, ownedOnly: true }),
    cursor
  );

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
          ACTIVE_CALL_STATUSES.includes(call.status)
        )}
      />
      <CallFilters showOwner={false} />
      <CallTable
        calls={calls}
        showOwner={false}
        filtered={hasActiveCallFilters(params)}
      />
      <CallPagination nextCursor={nextCursor} shown={calls.length} />
    </main>
  );
}
