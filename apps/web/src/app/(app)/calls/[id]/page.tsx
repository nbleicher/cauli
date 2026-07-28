import type { CallStatus, ReviewStatus, SourceMode } from "@calllog/shared";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CallDetailClient } from "@/components/CallDetailClient";
import { ProcessingPoller } from "@/components/ProcessingPoller";
import type { ReviewEditorProps } from "@/components/ReviewEditor";
import { PageHeader } from "@/components/PageHeader";
import { formatDate } from "@/lib/format";
import { requirePageAuth } from "@/lib/server/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

interface ProfileRelation {
  display_name: string;
  email: string;
}

interface ScorecardTemplate {
  id: string;
  name: string;
}

interface RevisionAnswer {
  criterionId: string;
  value: 1 | 2 | 3 | 4 | 5 | null;
  comment: string;
}

interface RevisionHistoryRow {
  id: string;
  revision: number;
  scorecard_version_id: string;
  status: ReviewStatus;
  score: number | string | null;
  summary: string;
  follow_up: string;
  follow_up_state: string;
  answers: RevisionAnswer[];
  submitted_by_name: string;
  submitted_at: string;
}

function firstRelation<T>(relation: T | T[] | null): T | null {
  return Array.isArray(relation) ? (relation[0] ?? null) : relation;
}

export default async function CallDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { user, member } = await requirePageAuth();
  const supabase = await createServerSupabaseClient();

  const { data: rawCall } = await supabase
    .from("calls")
    .select(
      `
      id, workspace_id, owner_id, title, source_mode, status, review_status,
      started_at, duration_ms, mic_label, tab_label, source_bytes, error_message,
      degraded, degraded_intervals,
      source_path, mp3_path, wav_path,
      owner:profiles!calls_owner_id_fkey(display_name, email)
    `
    )
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!rawCall) notFound();
  const owner = firstRelation(
    rawCall.owner as unknown as ProfileRelation | ProfileRelation[] | null
  );

  // The database calculates the schedule from the Workspace's Retention Policy
  // so a policy change moves every Call at once and none can show a stale date.
  const { data: retentionSchedule } = await supabase
    .from("call_retention_schedule")
    .select("retention_days, scheduled_deletion_at")
    .eq("call_id", id)
    .maybeSingle();

  const { data: transcript } = await supabase
    .from("transcripts")
    .select("id, full_text")
    .eq("call_id", id)
    .maybeSingle();

  const { data: segments } = transcript
    ? await supabase
        .from("transcript_segments")
        .select("id, sequence, start_ms, end_ms, text")
        .eq("transcript_id", transcript.id)
        .order("sequence")
    : { data: [] };

  const { data: activeExport } = await supabase
    .from("export_jobs")
    .select("id")
    .eq("call_id", id)
    .in("status", ["queued", "processing", "retrying"])
    .limit(1)
    .maybeSingle();

  const { data: existingReview } = await supabase
    .from("call_reviews")
    .select("id, scorecard_version_id, status, summary, follow_up, version")
    .eq("call_id", id)
    .maybeSingle();

  const { data: assignment } = await supabase
    .from("call_review_assignments")
    .select(
      `
      assignee_id, version,
      assignee:profiles!call_review_assignments_assignee_id_fkey(display_name, email)
    `
    )
    .eq("call_id", id)
    .maybeSingle();

  const { data: trackedFollowUp } = await supabase
    .from("follow_ups")
    .select("due_date")
    .eq("call_id", id)
    .maybeSingle();

  const { data: revisionHistoryData } = await supabase.rpc(
    "review_revision_history",
    { target_call_id: id }
  );
  const revisionHistory =
    (revisionHistoryData as RevisionHistoryRow[] | null) ?? [];
  const latestVisibleRevision = revisionHistory[0] ?? null;

  let template: ScorecardTemplate | null = null;
  let scorecardVersionNumber = 0;
  let scorecardVersionId =
    existingReview?.scorecard_version_id ??
    latestVisibleRevision?.scorecard_version_id ??
    "";
  if (scorecardVersionId) {
    const { data: boundVersion } = await supabase
      .from("scorecard_versions")
      .select("template_id, name, version")
      .eq("id", scorecardVersionId)
      .maybeSingle();
    if (boundVersion) {
      const { data: boundTemplate } = await supabase
        .from("scorecard_templates")
        .select("id, name")
        .eq("id", boundVersion.template_id)
        .maybeSingle();
      template = boundTemplate;
      if (template && boundVersion.name) template.name = boundVersion.name;
      scorecardVersionNumber = boundVersion.version;
    }
  } else {
    const { data: activeTemplate } = await supabase
      .from("scorecard_templates")
      .select("id, name")
      .eq("workspace_id", rawCall.workspace_id)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    template = activeTemplate;
  }

  if (!scorecardVersionId && template) {
    const { data: latestVersion } = await supabase
      .from("scorecard_versions")
      .select("id, version")
      .eq("template_id", template.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    scorecardVersionId = latestVersion?.id ?? "";
    scorecardVersionNumber = latestVersion?.version ?? 0;
  }

  let reviewProps: ReviewEditorProps | null = null;
  if (template && scorecardVersionId) {
    const { data: categories } = await supabase
      .from("scorecard_categories")
      .select("id, name, position")
      .eq("version_id", scorecardVersionId)
      .order("position");
    const categoryIds = (categories ?? []).map((category) => category.id);
    const { data: criteria } = categoryIds.length
      ? await supabase
          .from("scorecard_criteria")
          .select(
            "id, category_id, label, description, weight, required, position"
          )
          .in("category_id", categoryIds)
          .order("position")
      : { data: [] };

    const { data: currentAnswers } = existingReview
      ? await supabase
          .from("call_review_answers")
          .select("criterion_id, value, comment")
          .eq("review_id", existingReview.id)
      : { data: [] };

    const assignee = assignment
      ? firstRelation(
          assignment.assignee as unknown as
            ProfileRelation | ProfileRelation[] | null
        )
      : null;

    reviewProps = {
      callId: id,
      scorecardVersionId,
      scorecardVersionNumber,
      scorecardName: template.name,
      categories: (categories ?? []).map((category) => ({
        id: category.id,
        name: category.name,
        criteria: (criteria ?? [])
          .filter((criterion) => criterion.category_id === category.id)
          .map((criterion) => ({
            id: criterion.id,
            label: criterion.label,
            description: criterion.description,
            weight: criterion.weight,
            required: criterion.required,
          })),
      })),
      initialReview: existingReview
        ? {
            version: existingReview.version,
            status: existingReview.status as ReviewStatus,
            summary: existingReview.summary,
            followUp: existingReview.follow_up,
            followUpDueDate: trackedFollowUp?.due_date ?? null,
            answers: (currentAnswers ?? []).map((answer) => ({
              criterionId: answer.criterion_id,
              value: answer.value as 1 | 2 | 3 | 4 | 5 | null,
              comment: answer.comment,
            })),
          }
        : latestVisibleRevision
          ? {
              version: latestVisibleRevision.revision,
              status: latestVisibleRevision.status,
              summary: latestVisibleRevision.summary,
              followUp: latestVisibleRevision.follow_up,
              followUpDueDate: trackedFollowUp?.due_date ?? null,
              answers: latestVisibleRevision.answers,
            }
          : null,
      assignment: assignment
        ? {
            assigneeId: assignment.assignee_id,
            assigneeName:
              assignee?.display_name || assignee?.email || "Unknown",
            version: assignment.version,
          }
        : null,
      revisions: revisionHistory.map((revision) => ({
        id: revision.id,
        revision: revision.revision,
        scorecardVersionId: revision.scorecard_version_id,
        status: revision.status,
        score: revision.score === null ? null : Number(revision.score),
        summary: revision.summary,
        followUp: revision.follow_up,
        followUpState: revision.follow_up_state,
        answers: revision.answers,
        submittedAt: revision.submitted_at,
        submittedBy: revision.submitted_by_name,
      })),
    };
  }

  return (
    <main className="page">
      <Link
        href={member.role === "member" ? "/calls" : "/workspace"}
        className="back-link"
      >
        <ArrowLeft size={15} /> Back to calls
      </Link>
      <PageHeader
        title={rawCall.title || `Call · ${formatDate(rawCall.started_at)}`}
        description="Recording, transcript, exports, and QA review."
      />
      <ProcessingPoller
        active={
          ["recording", "uploading", "queued", "processing"].includes(
            rawCall.status
          ) || Boolean(activeExport)
        }
      />
      <CallDetailClient
        call={{
          id: rawCall.id,
          title: rawCall.title,
          ownerId: rawCall.owner_id,
          ownerName: owner?.display_name || owner?.email || "Unknown",
          startedAt: rawCall.started_at,
          durationMs: rawCall.duration_ms,
          sourceMode: rawCall.source_mode as SourceMode,
          degraded: rawCall.degraded,
          degradedIntervalCount: Array.isArray(rawCall.degraded_intervals)
            ? rawCall.degraded_intervals.length
            : 0,
          status: rawCall.status as CallStatus,
          reviewStatus: rawCall.review_status as ReviewStatus,
          micLabel: rawCall.mic_label,
          tabLabel: rawCall.tab_label,
          sourceBytes: rawCall.source_bytes,
          errorMessage: rawCall.error_message,
          hasSource: Boolean(rawCall.source_path),
          hasMp3: Boolean(rawCall.mp3_path),
          hasWav: Boolean(rawCall.wav_path),
          retentionDays: retentionSchedule?.retention_days ?? null,
          scheduledDeletionAt: retentionSchedule?.scheduled_deletion_at ?? null,
        }}
        segments={segments ?? []}
        transcriptText={transcript?.full_text ?? ""}
        currentUserId={user.id}
        role={member.role}
        review={reviewProps}
      />
    </main>
  );
}
