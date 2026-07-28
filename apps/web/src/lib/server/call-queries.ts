import type { CallStatus, ReviewStatus, SourceMode } from "@calllog/shared";
import type { CallTableRow } from "@/components/CallTable";
import { createServerSupabaseClient } from "@/lib/supabase/server";

interface RawCallRow {
  id: string;
  title: string | null;
  source_mode: SourceMode;
  status: CallStatus;
  review_status: ReviewStatus;
  started_at: string;
  duration_ms: number;
  degraded: boolean;
  owner:
    | { display_name: string; email: string }
    | { display_name: string; email: string }[]
    | null;
}

interface RawAssignmentRow {
  call_id: string;
  assignee_id: string;
  version: number;
  assignee:
    | { display_name: string; email: string }
    | { display_name: string; email: string }[]
    | null;
}

function ownerLabel(owner: RawCallRow["owner"]) {
  const profile = Array.isArray(owner) ? owner[0] : owner;
  return profile?.display_name || profile?.email || "Unknown";
}

export async function listCalls(ownerId?: string): Promise<CallTableRow[]> {
  const supabase = await createServerSupabaseClient();
  let query = supabase
    .from("calls")
    .select(
      `
      id, title, source_mode, status, review_status, started_at, duration_ms, degraded,
      owner:profiles!calls_owner_id_fkey(display_name, email)
    `
    )
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(250);
  if (ownerId) query = query.eq("owner_id", ownerId);

  const { data, error } = await query;
  if (error) throw error;

  const callIds = (data ?? []).map((call) => call.id);
  const { data: assignmentData, error: assignmentError } = callIds.length
    ? await supabase
        .from("call_review_assignments")
        .select(
          `
          call_id, assignee_id, version,
          assignee:profiles!call_review_assignments_assignee_id_fkey(display_name, email)
        `
        )
        .in("call_id", callIds)
    : { data: [], error: null };
  if (assignmentError) throw assignmentError;
  const assignments = new Map(
    (assignmentData as unknown as RawAssignmentRow[]).map((assignment) => [
      assignment.call_id,
      assignment,
    ])
  );

  return (data as unknown as RawCallRow[]).map((call) => {
    const assignment = assignments.get(call.id);
    return {
      id: call.id,
      title: call.title,
      ownerName: ownerLabel(call.owner),
      sourceMode: call.source_mode,
      status: call.status,
      reviewStatus: call.review_status,
      startedAt: call.started_at,
      durationMs: call.duration_ms,
      degraded: call.degraded,
      reviewAssigneeId: assignment?.assignee_id ?? null,
      reviewAssigneeName: assignment ? ownerLabel(assignment.assignee) : null,
      assignmentVersion: assignment?.version ?? 0,
    };
  });
}
