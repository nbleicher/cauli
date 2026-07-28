import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
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

// A fixed instant keeps the expected schedule arithmetic exact: 90 days later
// is 1 April 2026, 30 days later is 31 January 2026.
const recordedAt = "2026-01-01T00:00:00.000Z";

test.skip(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY,
  "requires the local Supabase stack"
);

/**
 * Call Detail renders the instant through Intl in the browser's own locale and
 * zone, so the expectation is built the same way rather than hard-coded.
 */
function displayedInstant(page: Page, isoInstant: string) {
  return page.evaluate(
    (value) =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value)),
    isoInstant
  );
}

test("an Admin sets the Retention Policy every Workspace Member can read", async ({
  page,
}) => {
  const adminEmail = `retention-admin-${crypto.randomUUID()}@example.com`;
  const memberEmail = `retention-member-${crypto.randomUUID()}@example.com`;
  const password = `Test-${crypto.randomUUID()}!`;
  const createdUserIds: string[] = [];
  let callId = "";

  try {
    for (const [email, role] of [
      [adminEmail, "admin"],
      [memberEmail, "member"],
    ] as const) {
      const { data: created, error: createError } =
        await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });
      if (createError) throw createError;
      createdUserIds.push(created.user.id);
      const { error: membershipError } = await admin
        .from("workspace_members")
        .insert({ workspace_id: workspaceId, user_id: created.user.id, role });
      if (membershipError) throw membershipError;
    }
    const [adminUserId, memberUserId] = createdUserIds;

    const { data: call, error: callError } = await admin
      .from("calls")
      .insert({
        workspace_id: workspaceId,
        owner_id: memberUserId,
        title: "Retention schedule",
        source_mode: "both",
        status: "ready",
        chunk_prefix: `${workspaceId}/retention/chunks`,
        started_at: recordedAt,
        recording_attested_by: memberUserId,
        recording_attested_at: recordedAt,
      })
      .select("id")
      .single();
    if (callError) throw callError;
    callId = call.id;

    const adminClient = createClient(localUrl, anonKey, {
      auth: { persistSession: false },
    });
    const { error: adminSignInError } =
      await adminClient.auth.signInWithPassword({
        email: adminEmail,
        password,
      });
    if (adminSignInError) throw adminSignInError;
    const { secret } = await enrollVerifiedTotp(adminClient);

    await signInAsWorkspaceMember(page, adminEmail, password, 2, secret);

    // The Workspace starts on the mandatory 90-day default.
    await page.goto(`/calls/${callId}`);
    await expect(page.getByText("Scheduled deletion")).toBeVisible();
    const scheduleValue = page
      .locator(".call-facts div")
      .filter({ hasText: "Scheduled deletion" })
      .locator("dd");
    await expect(scheduleValue).toHaveText(
      await displayedInstant(page, "2026-04-01T00:00:00.000Z")
    );

    await page.goto("/admin/workspace");
    const retentionSelect = page.getByLabel("Delete Calls after");
    await expect(retentionSelect).toHaveValue("90");

    const changeResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === "/api/admin/retention"
    );
    await retentionSelect.selectOption("30");
    expect((await changeResponse).status()).toBe(200);
    await expect(page.locator(".notice-banner")).toContainText(
      "deleted 30 days after"
    );

    // The schedule is calculated, so the Call that was already recorded moved
    // with the policy instead of keeping the date it was shown before.
    await page.goto(`/calls/${callId}`);
    await expect(scheduleValue).toHaveText(
      await displayedInstant(page, "2026-01-31T00:00:00.000Z")
    );

    const { data: auditEvent } = await admin
      .from("audit_events")
      .select("action, entity_id, metadata")
      .eq("workspace_id", workspaceId)
      .eq("action", "workspace.retention.changed")
      .eq("actor_id", adminUserId)
      .single();
    expect(auditEvent).toMatchObject({
      entity_id: workspaceId,
      metadata: { previous_days: 90, retention_days: 30 },
    });

    // A Member Role reads the same rule and is never offered the control.
    await page.request.post("/api/auth/signout");
    await page.context().clearCookies();
    await signInAsWorkspaceMember(page, memberEmail, password);
    await page.goto("/calls");
    await expect(
      page.getByText("deletes every Call 30 days after it is recorded")
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Workspace Admin" })
    ).toHaveCount(0);

    const deniedResponse = await page.request.patch("/api/admin/retention", {
      data: { retentionDays: 365 },
    });
    expect(deniedResponse.status()).toBe(403);
    const { data: unchanged } = await admin
      .from("workspaces")
      .select("retention_days")
      .eq("id", workspaceId)
      .single();
    expect(unchanged?.retention_days).toBe(30);
  } finally {
    if (callId) await admin.from("calls").delete().eq("id", callId);
    await admin
      .from("workspaces")
      .update({ retention_days: 90 })
      .eq("id", workspaceId);
    for (const userId of createdUserIds) {
      await admin.from("workspace_members").delete().eq("user_id", userId);
      await admin.auth.admin.deleteUser(userId);
    }
  }
});
