import { submitReviewSchema, validateReviewCompletion } from "@calllog/shared";
import { NextResponse } from "next/server";
import { authorizeCall } from "@/lib/server/calls";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(["manager", "admin"]);
  if (isAuthError(auth)) return auth;
  const { id } = await params;
  if (!(await authorizeCall(auth, id, "review"))) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 });
  }

  const parsed = await parseJson(request, submitReviewSchema);
  if (parsed.error) return parsed.error;
  const scorecardVersionId = new URL(request.url).searchParams.get(
    "scorecardVersionId"
  );
  if (!scorecardVersionId) {
    return NextResponse.json(
      { error: "scorecardVersionId is required" },
      { status: 400 }
    );
  }

  const supabase = await createServerSupabaseClient();
  const { data: categories, error: categoryError } = await supabase
    .from("scorecard_categories")
    .select("id")
    .eq("version_id", scorecardVersionId);
  if (categoryError) {
    return NextResponse.json(
      { error: sanitizeError(categoryError) },
      { status: 500 }
    );
  }
  const categoryIds = (categories ?? []).map((category) => category.id);
  const { data: criteria, error: criteriaError } = categoryIds.length
    ? await supabase
        .from("scorecard_criteria")
        .select("id, required")
        .in("category_id", categoryIds)
    : { data: [], error: null };
  if (criteriaError) {
    return NextResponse.json(
      { error: sanitizeError(criteriaError) },
      { status: 500 }
    );
  }
  const issues = validateReviewCompletion(parsed.data, criteria ?? []);
  if (issues.length) {
    return NextResponse.json(
      {
        error: "Review is incomplete",
        issues,
      },
      { status: 422 }
    );
  }

  const { data, error } = await supabase.rpc("submit_call_review", {
    target_call_id: id,
    target_scorecard_version_id: scorecardVersionId,
    expected_version: parsed.data.expectedVersion,
    target_status: parsed.data.status,
    target_summary: parsed.data.summary,
    target_follow_up: parsed.data.followUp,
    target_answers: parsed.data.answers,
  });

  if (error) {
    const conflict = /version conflict/i.test(error.message);
    return NextResponse.json(
      { error: sanitizeError(error) },
      {
        status: conflict ? 409 : 500,
      }
    );
  }
  return NextResponse.json({ review: data });
}
