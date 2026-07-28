import { FollowUpQueue } from "@/components/FollowUpQueue";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAuth } from "@/lib/server/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

interface FollowUpQueueRow {
  id: string;
  call_id: string;
  call_title: string | null;
  owner_name: string;
  review_assignee_name: string;
  description: string;
  due_date: string;
  display_status: string;
  version: number;
  can_resolve: boolean;
  can_verify: boolean;
}

export default async function FollowUpsPage() {
  await requirePageAuth();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("follow_up_queue");
  if (error) throw error;
  const rows = (data as FollowUpQueueRow[] | null) ?? [];

  return (
    <main className="page">
      <PageHeader
        title="Follow-ups"
        description="Open, Overdue, and resolved work waiting for verified closure."
      />
      <FollowUpQueue
        items={rows.map((row) => ({
          id: row.id,
          callId: row.call_id,
          callTitle: row.call_title,
          ownerName: row.owner_name,
          reviewAssigneeName: row.review_assignee_name,
          description: row.description,
          dueDate: row.due_date,
          displayStatus: row.display_status,
          version: row.version,
          canResolve: row.can_resolve,
          canVerify: row.can_verify,
        }))}
      />
    </main>
  );
}
