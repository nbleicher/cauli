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

test("a Call owner sees complete submissions but not a newer draft", async ({
  page,
}) => {
  const password = `Test-${crypto.randomUUID()}!`;
  const managerEmail = `history-manager-${crypto.randomUUID()}@example.com`;
  const ownerEmail = `history-owner-${crypto.randomUUID()}@example.com`;
  const { data: managerResult, error: managerError } =
    await admin.auth.admin.createUser({
      email: managerEmail,
      password,
      email_confirm: true,
    });
  if (managerError) throw managerError;
  const { data: ownerResult, error: ownerError } =
    await admin.auth.admin.createUser({
      email: ownerEmail,
      password,
      email_confirm: true,
    });
  if (ownerError) throw ownerError;

  let callId = "";
  let templateId = "";
  try {
    const { error: membershipError } = await admin
      .from("workspace_members")
      .insert([
        {
          workspace_id: workspaceId,
          user_id: managerResult.user.id,
          role: "manager",
        },
        {
          workspace_id: workspaceId,
          user_id: ownerResult.user.id,
          role: "member",
        },
      ]);
    if (membershipError) throw membershipError;

    const managerClient = createClient(localUrl, anonKey, {
      auth: { persistSession: false },
    });
    const { error: managerSignInError } =
      await managerClient.auth.signInWithPassword({
        email: managerEmail,
        password,
      });
    if (managerSignInError) throw managerSignInError;
    await enrollVerifiedTotp(managerClient);

    const { data: scorecardVersionId, error: publishError } = await admin.rpc(
      "publish_scorecard",
      {
        target_workspace_id: workspaceId,
        target_template_id: null,
        target_name: "Revision history Scorecard",
        target_actor_id: managerResult.user.id,
        target_categories: [
          {
            name: "Quality",
            criteria: [
              {
                label: "Clear outcome",
                description: "",
                weight: 1,
                required: true,
              },
            ],
          },
        ],
      }
    );
    if (publishError) throw publishError;
    const { data: version, error: versionError } = await admin
      .from("scorecard_versions")
      .select("template_id")
      .eq("id", scorecardVersionId)
      .single();
    if (versionError) throw versionError;
    templateId = version.template_id;
    const { data: category } = await admin
      .from("scorecard_categories")
      .select("id")
      .eq("version_id", scorecardVersionId)
      .single();
    const { data: criterion } = await admin
      .from("scorecard_criteria")
      .select("id")
      .eq("category_id", category!.id)
      .single();

    callId = crypto.randomUUID();
    const { error: callError } = await admin.from("calls").insert({
      id: callId,
      workspace_id: workspaceId,
      owner_id: ownerResult.user.id,
      title: "Revision visibility Call",
      source_mode: "both",
      status: "ready",
      chunk_prefix: `${workspaceId}/${callId}/chunks`,
      recording_attested_by: ownerResult.user.id,
      recording_attested_at: new Date().toISOString(),
    });
    if (callError) throw callError;
    const { error: claimError } = await managerClient.rpc("claim_review", {
      target_call_id: callId,
    });
    if (claimError) throw claimError;

    const { error: firstSubmitError } = await managerClient.rpc(
      "submit_call_review",
      {
        target_call_id: callId,
        target_scorecard_version_id: scorecardVersionId,
        expected_version: 0,
        expected_assignment_version: 1,
        target_status: "reviewed",
        target_summary: "First visible summary.",
        target_follow_up: "",
        target_answers: [
          {
            criterionId: criterion!.id,
            value: 5,
            comment: "Visible criterion comment.",
          },
        ],
      }
    );
    if (firstSubmitError) throw firstSubmitError;
    const { error: draftSubmitError } = await managerClient.rpc(
      "submit_call_review",
      {
        target_call_id: callId,
        target_scorecard_version_id: scorecardVersionId,
        expected_version: 1,
        expected_assignment_version: 1,
        target_status: "in_progress",
        target_summary: "Private draft summary.",
        target_follow_up: "",
        target_answers: [
          {
            criterionId: criterion!.id,
            value: 1,
            comment: "Private draft comment.",
          },
        ],
      }
    );
    if (draftSubmitError) throw draftSubmitError;

    await signInAsWorkspaceMember(page, ownerEmail, password);
    await page.goto(`/calls/${callId}`);
    await expect(
      page.getByText("Revision history Scorecard", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("First visible summary.", { exact: true })
    ).toBeVisible();
    await expect(page.getByText("Private draft summary.")).toHaveCount(0);
    await expect(page.getByText("Private draft comment.")).toHaveCount(0);

    await page.getByText("1 visible revision", { exact: true }).click();
    await page.getByText(/Revision 1 · reviewed/).click();
    await expect(
      page.getByText(/Clear outcome: 5 · Visible criterion comment\./)
    ).toBeVisible();
    await expect(page.getByText(/Scorecard Version 1/)).toBeVisible();
  } finally {
    if (callId) await admin.from("calls").delete().eq("id", callId);
    if (templateId) {
      await admin.from("scorecard_templates").delete().eq("id", templateId);
    }
    const { error: managerCleanupError } = await admin.auth.admin.deleteUser(
      managerResult.user.id
    );
    if (managerCleanupError) throw managerCleanupError;
    const { error: ownerCleanupError } = await admin.auth.admin.deleteUser(
      ownerResult.user.id
    );
    if (ownerCleanupError) throw ownerCleanupError;
  }
});
