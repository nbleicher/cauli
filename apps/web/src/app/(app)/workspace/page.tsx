import { redirect } from "next/navigation";
import { CallTable } from "@/components/CallTable";
import { PageHeader } from "@/components/PageHeader";
import { ProcessingPoller } from "@/components/ProcessingPoller";
import { listCalls } from "@/lib/server/call-queries";
import { requirePageAuth } from "@/lib/server/auth";

export default async function WorkspaceCallsPage() {
  const { member } = await requirePageAuth();
  if (member.role === "member") redirect("/calls");
  const calls = await listCalls();

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
      <CallTable calls={calls} showOwner />
    </main>
  );
}
