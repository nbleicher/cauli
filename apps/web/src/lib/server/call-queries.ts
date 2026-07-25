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
  owner: { display_name: string; email: string } | { display_name: string; email: string }[] | null;
}

function ownerLabel(owner: RawCallRow["owner"]) {
  const profile = Array.isArray(owner) ? owner[0] : owner;
  return profile?.display_name || profile?.email || "Unknown";
}

export async function listCalls(ownerId?: string): Promise<CallTableRow[]> {
  const supabase = await createServerSupabaseClient();
  let query = supabase
    .from("calls")
    .select(`
      id, title, source_mode, status, review_status, started_at, duration_ms,
      owner:profiles!calls_owner_id_fkey(display_name, email)
    `)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(250);
  if (ownerId) query = query.eq("owner_id", ownerId);

  const { data, error } = await query;
  if (error) throw error;

  return (data as unknown as RawCallRow[]).map((call) => ({
    id: call.id,
    title: call.title,
    ownerName: ownerLabel(call.owner),
    sourceMode: call.source_mode,
    status: call.status,
    reviewStatus: call.review_status,
    startedAt: call.started_at,
    durationMs: call.duration_ms,
  }));
}
