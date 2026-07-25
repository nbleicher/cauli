import { redirect } from "next/navigation";
import { CallTable } from "@/components/CallTable";
import { PageHeader } from "@/components/PageHeader";
import { listCalls } from "@/lib/server/call-queries";
import { requirePageAuth } from "@/lib/server/auth";

export default async function TeamCallsPage() {
  const { member } = await requirePageAuth();
  if (member.role === "member") redirect("/calls");
  const calls = await listCalls();

  return (
    <main className="page">
      <PageHeader
        title="Team Calls"
        description="Review every call recorded in this workspace."
      />
      <CallTable calls={calls} showOwner />
    </main>
  );
}
