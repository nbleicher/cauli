import { ACTIVE_CALL_STATUSES } from "@calllog/shared";
import { redirect } from "next/navigation";
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
      <CallTable
        calls={calls}
        showOwner
        filtered={hasActiveCallFilters(params)}
      />
      <CallPagination nextCursor={nextCursor} shown={calls.length} />
    </main>
  );
}
