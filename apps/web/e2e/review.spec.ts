import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { signInAsWorkspaceMember } from "./helpers/auth";
import { enrollVerifiedTotp } from "./helpers/totp";

const localUrl = "http://127.0.0.1:54321";
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "integration-test-anon-key";
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
  const { data: reviewer, error: reviewerError } =
    await admin.auth.admin.createUser({
      email: reviewerEmail,
      password,
      email_confirm: true,
    });
  if (reviewerError) throw reviewerError;
  const { data: owner, error: ownerError } = await admin.auth.admin.createUser({
    email: ownerEmail,
    password,
    email_confirm: true,
  });
  if (ownerError) throw ownerError;

  let templateId = "";
  let replacementTemplateId = "";
  let callId = "";
  try {
    const { error: membershipError } = await admin
      .from("workspace_members")
      .insert([
        {
          workspace_id: workspaceId,
          user_id: reviewer.user.id,
          role: "admin",
        },
        {
          workspace_id: workspaceId,
          user_id: owner.user.id,
          role: "member",
        },
      ]);
    if (membershipError) throw membershipError;
    const reviewerClient = createClient(localUrl, anonKey, {
      auth: { persistSession: false },
    });
    const { error: signInError } = await reviewerClient.auth.signInWithPassword(
      {
        email: reviewerEmail,
        password,
      }
    );
    if (signInError) throw signInError;
    const { secret: reviewerTotpSecret } =
      await enrollVerifiedTotp(reviewerClient);

    const { data: call, error: callError } = await admin
      .from("calls")
      .insert({
        workspace_id: workspaceId,
        owner_id: owner.user.id,
        source_mode: "both",
        status: "ready",
        chunk_prefix: `${workspaceId}/review-test/chunks`,
        recording_attested_by: owner.user.id,
        recording_attested_at: new Date().toISOString(),
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

    const { data: versionId, error: versionError } = await admin.rpc(
      "publish_scorecard",
      {
        target_workspace_id: workspaceId,
        target_template_id: template.id,
        target_name: "Review API test",
        target_actor_id: reviewer.user.id,
        target_categories: [
          {
            name: "Discovery",
            criteria: [
              {
                label: "Asked a discovery question",
                description: "",
                weight: 1,
                required: true,
              },
              {
                label: "Confirmed the next step",
                description: "",
                weight: 100,
                required: false,
              },
            ],
          },
        ],
      }
    );
    if (versionError) throw versionError;
    const version = { id: versionId as string };
    const { data: category, error: categoryError } = await admin
      .from("scorecard_categories")
      .select("id")
      .eq("version_id", version.id)
      .single();
    if (categoryError) throw categoryError;
    const { data: criteria, error: criterionError } = await admin
      .from("scorecard_criteria")
      .select("id, label, required")
      .eq("category_id", category.id)
      .order("position");
    if (criterionError) throw criterionError;
    const criterion = criteria?.find((item) => item.required);
    const optionalCriterion = criteria?.find((item) => !item.required);
    if (!criterion || !optionalCriterion) {
      throw new Error("Expected required and optional Scorecard criteria");
    }

    await signInAsWorkspaceMember(
      page,
      reviewerEmail,
      password,
      2,
      reviewerTotpSecret
    );

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
          {
            criterionId: optionalCriterion.id,
            value: null,
            comment: "Not applicable to this Call.",
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

    const { error: immutableCriterionError } = await admin
      .from("scorecard_criteria")
      .update({ label: "Rewritten criterion" })
      .eq("id", criterion.id);
    expect(immutableCriterionError?.message).toMatch(/immutable/i);

    await page.goto("/admin/scorecards");
    const requiredToggles = page.locator(".criterion-required-field input");
    await expect(requiredToggles).toHaveCount(2);
    await expect(requiredToggles.nth(0)).toBeChecked();
    await expect(requiredToggles.nth(1)).not.toBeChecked();
    await requiredToggles.nth(0).uncheck();
    await page.getByRole("button", { name: "Publish version" }).click();
    await expect(page.getByText(/Published version 2/)).toBeVisible();

    const versionToggles = page.locator(".version-selection input");
    await expect(versionToggles).toHaveCount(2);
    await versionToggles.nth(0).check();
    await versionToggles.nth(1).check();
    await page
      .getByRole("button", { name: "Mark selected versions comparable" })
      .click();
    await expect(page.getByText(/currently comparable/).first()).toBeVisible();

    await page.getByRole("button", { name: "Stop combining" }).click();
    await expect(page.getByText(/currently comparable/)).toHaveCount(0);

    const { data: scorecardAudit } = await admin
      .from("audit_events")
      .select("action")
      .eq("workspace_id", workspaceId)
      .in("action", [
        "scorecard.version.published",
        "scorecard.versions.comparable",
        "scorecard.versions.comparability_revoked",
      ]);
    expect(
      new Set((scorecardAudit ?? []).map((event) => event.action))
    ).toEqual(
      new Set([
        "scorecard.version.published",
        "scorecard.versions.comparable",
        "scorecard.versions.comparability_revoked",
      ])
    );

    const { error: deactivateError } = await admin
      .from("scorecard_templates")
      .update({ is_active: false })
      .eq("id", template.id);
    if (deactivateError) throw deactivateError;
    const replacementName = `Current Review template ${crypto.randomUUID()}`;
    const { data: replacement, error: replacementError } = await admin
      .from("scorecard_templates")
      .insert({
        workspace_id: workspaceId,
        name: replacementName,
        created_by: reviewer.user.id,
      })
      .select("id")
      .single();
    if (replacementError) throw replacementError;
    replacementTemplateId = replacement.id;

    await page.goto(`/calls/${call.id}`);
    await expect(
      page.getByText("Review API test", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByText(replacementName, { exact: true })
    ).not.toBeVisible();
  } finally {
    if (callId) {
      await admin.from("calls").delete().eq("id", callId);
    }
    if (templateId) {
      await admin.from("scorecard_templates").delete().eq("id", templateId);
    }
    if (replacementTemplateId) {
      await admin
        .from("scorecard_templates")
        .delete()
        .eq("id", replacementTemplateId);
    }
    const { error: reviewerCleanupError } = await admin.auth.admin.deleteUser(
      reviewer.user.id
    );
    if (reviewerCleanupError) throw reviewerCleanupError;
    const { error: ownerCleanupError } = await admin.auth.admin.deleteUser(
      owner.user.id
    );
    if (ownerCleanupError) throw ownerCleanupError;
  }
});
