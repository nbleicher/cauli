import { ACTIVE_CALL_STATUSES } from "@calllog/shared";
import { CallTable } from "@/components/CallTable";
import { PageHeader } from "@/components/PageHeader";
import { ProcessingPoller } from "@/components/ProcessingPoller";
import { listCalls } from "@/lib/server/call-queries";
import { requirePageAuth } from "@/lib/server/auth";

export default async function MyCallsPage() {
  const { user } = await requirePageAuth();
  const calls = await listCalls(user.id);

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
      <CallTable calls={calls} showOwner={false} />
    </main>
  );
}
