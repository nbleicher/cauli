import type { CallStatus, ReviewStatus, SourceMode } from "@calllog/shared";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CallDetailClient } from "@/components/CallDetailClient";
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

  const { data: existingReview } = await supabase
    .from("call_reviews")
    .select("id, scorecard_version_id, status, summary, follow_up, version")
    .eq("call_id", id)
    .maybeSingle();

  let template: ScorecardTemplate | null = null;
  let scorecardVersionId = existingReview?.scorecard_version_id ?? "";
  if (scorecardVersionId) {
    const { data: boundVersion } = await supabase
      .from("scorecard_versions")
      .select("template_id")
      .eq("id", scorecardVersionId)
      .maybeSingle();
    if (boundVersion) {
      const { data: boundTemplate } = await supabase
        .from("scorecard_templates")
        .select("id, name")
        .eq("id", boundVersion.template_id)
        .maybeSingle();
      template = boundTemplate;
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
      .select("id")
      .eq("template_id", template.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    scorecardVersionId = latestVersion?.id ?? "";
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

    const { data: revisions } = existingReview
      ? await supabase
          .from("review_revisions")
          .select(
            `
          id, revision, status, score, submitted_at,
          submitter:profiles!review_revisions_submitted_by_fkey(display_name, email)
        `
          )
          .eq("review_id", existingReview.id)
          .order("revision", { ascending: false })
      : { data: [] };

    reviewProps = {
      callId: id,
      scorecardVersionId,
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
            answers: (currentAnswers ?? []).map((answer) => ({
              criterionId: answer.criterion_id,
              value: answer.value as 1 | 2 | 3 | 4 | 5 | null,
              comment: answer.comment,
            })),
          }
        : null,
      revisions: (revisions ?? []).map((revision) => {
        const submitter = firstRelation(
          revision.submitter as unknown as
            ProfileRelation | ProfileRelation[] | null
        );
        return {
          id: revision.id,
          revision: revision.revision,
          status: revision.status as ReviewStatus,
          score: revision.score === null ? null : Number(revision.score),
          submittedAt: revision.submitted_at,
          submittedBy: submitter?.display_name || submitter?.email || "Unknown",
        };
      }),
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
