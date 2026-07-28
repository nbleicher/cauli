import { ACTIVE_CALL_STATUSES } from "@calllog/shared";
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

export default async function MyCallsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user } = await requirePageAuth();
  const params = await searchParams;
  const cursor = typeof params.cursor === "string" ? params.cursor : null;
  const { calls, nextCursor } = await listCallsPage(
    parseCallFilters(params, { userId: user.id, ownedOnly: true }),
    cursor
  );

  return (
    <main className="page">
      <PageHeader
        title="My Calls"
        description="Your recordings, transcripts, exports, and completed reviews."
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
