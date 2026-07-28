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

test("a Needs Follow-up moves through owner and Review Assignee queues", async ({
  page,
}) => {
  const password = `Test-${crypto.randomUUID()}!`;
  const managerEmail = `follow-up-manager-${crypto.randomUUID()}@example.com`;
  const ownerEmail = `follow-up-owner-${crypto.randomUUID()}@example.com`;
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
    const { secret: managerTotpSecret } =
      await enrollVerifiedTotp(managerClient);

    const { data: scorecardVersionId, error: publishError } = await admin.rpc(
      "publish_scorecard",
      {
        target_workspace_id: workspaceId,
        target_template_id: null,
        target_name: "Follow-up journey Scorecard",
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
    const { data: version } = await admin
      .from("scorecard_versions")
      .select("template_id")
      .eq("id", scorecardVersionId)
      .single();
    templateId = version!.template_id;

    callId = crypto.randomUUID();
    const { error: callError } = await admin.from("calls").insert({
      id: callId,
      workspace_id: workspaceId,
      owner_id: ownerResult.user.id,
      title: "Follow-up queue Call",
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

    await signInAsWorkspaceMember(
      page,
      managerEmail,
      password,
      2,
      managerTotpSecret
    );
    await page.goto(`/calls/${callId}`);
    await page
      .locator(".scorecard-summary select")
      .selectOption("needs_follow_up");
    await page
      .getByRole("group", { name: "Clear outcome" })
      .getByRole("button", { name: "3" })
      .click();
    await page.getByLabel("Review summary").fill("Coaching action required.");
    await page
      .getByLabel("Required follow-up")
      .fill("Complete the agreed coaching action.");
    const expectedDefaultDueDate = new Date();
    expectedDefaultDueDate.setUTCDate(expectedDefaultDueDate.getUTCDate() + 7);
    await expect(page.getByLabel("Follow-up due date")).toHaveValue(
      expectedDefaultDueDate.toISOString().slice(0, 10)
    );
    const reviewResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/calls/${callId}/review`) &&
        response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Submit review" }).click();
    expect((await reviewResponse).status()).toBe(200);

    const { data: followUp, error: followUpError } = await admin
      .from("follow_ups")
      .select("id, due_date, status, version")
      .eq("call_id", callId)
      .single();
    if (followUpError) throw followUpError;
    expect(followUp).toMatchObject({
      due_date: expectedDefaultDueDate.toISOString().slice(0, 10),
      status: "open",
      version: 1,
    });

    await page.evaluate(() => window.localStorage.clear());
    await page.context().clearCookies();
    await signInAsWorkspaceMember(page, ownerEmail, password);
    await page.goto("/follow-ups");
    await expect(
      page.getByText("Complete the agreed coaching action.", { exact: true })
    ).toBeVisible();
    const resolveResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/follow-ups/${followUp.id}`) &&
        response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Mark Resolved" }).click();
    expect((await resolveResponse).status()).toBe(200);
    await expect(page.getByText("awaiting verification")).toBeVisible();

    await page.evaluate(() => window.localStorage.clear());
    await page.context().clearCookies();
    await signInAsWorkspaceMember(
      page,
      managerEmail,
      password,
      2,
      managerTotpSecret
    );
    await page.goto("/follow-ups");
    await expect(page.getByText("awaiting verification")).toBeVisible();
    const verifyResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/follow-ups/${followUp.id}`) &&
        response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Verify closure" }).click();
    expect((await verifyResponse).status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "No open Follow-ups" })
    ).toBeVisible();

    const { data: auditEvents } = await admin
      .from("audit_events")
      .select("action")
      .eq("entity_id", followUp.id);
    expect(auditEvents?.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "follow_up.created",
        "follow_up.resolved",
        "follow_up.verified",
      ])
    );
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
