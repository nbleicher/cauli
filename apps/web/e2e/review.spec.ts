import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { signInAsWorkspaceMember } from "./helpers/auth";

const localUrl = "http://127.0.0.1:54321";
const localServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const workspaceId = "00000000-0000-0000-0000-000000000001";
const admin = createClient(localUrl, localServiceRoleKey, {
  auth: { persistSession: false },
});

test.skip(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY,
  "requires the local Supabase stack"
);

test("review API enforces completion and optimistic concurrency", async ({
  page,
}) => {
  const password = `Test-${crypto.randomUUID()}!`;
  const reviewerEmail = `reviewer-${crypto.randomUUID()}@example.com`;
  const ownerEmail = `owner-${crypto.randomUUID()}@example.com`;
  const [
    { data: reviewer, error: reviewerError },
    { data: owner, error: ownerError },
  ] = await Promise.all([
    admin.auth.admin.createUser({
      email: reviewerEmail,
      password,
      email_confirm: true,
    }),
    admin.auth.admin.createUser({
      email: ownerEmail,
      password,
      email_confirm: true,
    }),
  ]);
  if (reviewerError) throw reviewerError;
  if (ownerError) throw ownerError;

  let templateId = "";
  let callId = "";
  try {
    const { error: membershipError } = await admin
      .from("workspace_members")
      .insert([
        {
          workspace_id: workspaceId,
          user_id: reviewer.user.id,
          role: "manager",
        },
        {
          workspace_id: workspaceId,
          user_id: owner.user.id,
          role: "member",
        },
      ]);
    if (membershipError) throw membershipError;

    const { data: call, error: callError } = await admin
      .from("calls")
      .insert({
        workspace_id: workspaceId,
        owner_id: owner.user.id,
        source_mode: "both",
        status: "ready",
        chunk_prefix: `${workspaceId}/review-test/chunks`,
      })
      .select("id")
      .single();
    if (callError) throw callError;
    callId = call.id;

    const { data: template, error: templateError } = await admin
      .from("scorecard_templates")
      .insert({
        workspace_id: workspaceId,
        name: "Review API test",
        created_by: reviewer.user.id,
      })
      .select("id")
      .single();
    if (templateError) throw templateError;
    templateId = template.id;

    const { data: version, error: versionError } = await admin
      .from("scorecard_versions")
      .insert({
        template_id: template.id,
        version: 1,
        published_by: reviewer.user.id,
      })
      .select("id")
      .single();
    if (versionError) throw versionError;
    const { data: category, error: categoryError } = await admin
      .from("scorecard_categories")
      .insert({
        version_id: version.id,
        name: "Discovery",
        position: 0,
      })
      .select("id")
      .single();
    if (categoryError) throw categoryError;
    const { data: criterion, error: criterionError } = await admin
      .from("scorecard_criteria")
      .insert({
        category_id: category.id,
        label: "Asked a discovery question",
        weight: 1,
        required: true,
        position: 0,
      })
      .select("id")
      .single();
    if (criterionError) throw criterionError;

    await signInAsWorkspaceMember(page, reviewerEmail, password);

    const endpoint = `/api/calls/${call.id}/review?scorecardVersionId=${version.id}`;
    const incomplete = await page.request.post(endpoint, {
      data: {
        expectedVersion: 0,
        status: "reviewed",
        summary: "",
        followUp: "",
        answers: [],
      },
    });
    expect(incomplete.status()).toBe(422);

    const submitted = await page.request.post(endpoint, {
      data: {
        expectedVersion: 0,
        status: "reviewed",
        summary: "Completed review.",
        followUp: "",
        answers: [
          {
            criterionId: criterion.id,
            value: 3,
            comment: "",
          },
        ],
      },
    });
    expect(submitted.status()).toBe(200);

    const stale = await page.request.post(endpoint, {
      data: {
        expectedVersion: 0,
        status: "reviewed",
        summary: "Stale overwrite.",
        followUp: "",
        answers: [
          {
            criterionId: criterion.id,
            value: 5,
            comment: "",
          },
        ],
      },
    });
    expect(stale.status()).toBe(409);

    const [{ data: review }, { count: revisionCount }] = await Promise.all([
      admin
        .from("call_reviews")
        .select("score, version, status")
        .eq("call_id", call.id)
        .single(),
      admin
        .from("review_revisions")
        .select("id", { count: "exact", head: true }),
    ]);
    expect(review).toMatchObject({
      score: 50,
      status: "reviewed",
      version: 1,
    });
    expect(revisionCount).toBe(1);
  } finally {
    if (callId) {
      await admin.from("calls").delete().eq("id", callId);
    }
    if (templateId) {
      await admin.from("scorecard_templates").delete().eq("id", templateId);
    }
    await Promise.all([
      admin.auth.admin.deleteUser(reviewer.user.id),
      admin.auth.admin.deleteUser(owner.user.id),
    ]);
  }
});
