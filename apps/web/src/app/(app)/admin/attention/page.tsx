import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { formatDate } from "@/lib/format";
import { requirePageAuth } from "@/lib/server/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

interface FailedJob {
  id: string;
  call_id: string | null;
  kind: string;
  attempts: number;
  error_category: string | null;
  error_chunk_index: number | null;
  provider_generation_id: string | null;
  error_message: string | null;
  finished_at: string | null;
}

export default async function NeedsAttentionPage() {
  const { member } = await requirePageAuth();
  if (member.role !== "admin") redirect("/record");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("processing_jobs")
    .select(
      `
      id, call_id, kind, attempts, error_category, error_chunk_index,
      provider_generation_id, error_message, finished_at
    `
    )
    .eq("workspace_id", member.workspaceId)
    .eq("status", "failed")
    .order("finished_at", { ascending: false })
    .limit(250);
  if (error) throw error;
  const jobs = (data ?? []) as FailedJob[];

  return (
    <main className="page">
      <PageHeader
        title="Needs Attention"
        description="Failed processing jobs with safe diagnostic details. Recordings remain available for retry."
      />
      {jobs.length === 0 ? (
        <section className="empty-state">
          <h2>No processing failures</h2>
          <p>Jobs that need an administrator will appear here.</p>
        </section>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Call</th>
                <th>Reason</th>
                <th>Chunk</th>
                <th>Attempts</th>
                <th>Generation</th>
                <th>Failed</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    {job.call_id ? (
                      <Link href={`/calls/${job.call_id}`}>
                        {job.call_id.slice(0, 8)}
                      </Link>
                    ) : (
                      job.kind
                    )}
                  </td>
                  <td>
                    <div className="table-primary">
                      <strong>
                        {job.error_category?.replaceAll("_", " ") ?? "internal"}
                      </strong>
                      <span>
                        {job.error_message ?? "No diagnostic message"}
                      </span>
                    </div>
                  </td>
                  <td className="mono">
                    {job.error_chunk_index === null
                      ? "—"
                      : job.error_chunk_index + 1}
                  </td>
                  <td className="mono">{job.attempts}</td>
                  <td className="mono">{job.provider_generation_id ?? "—"}</td>
                  <td>{job.finished_at ? formatDate(job.finished_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
