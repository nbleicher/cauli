import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { signInAsWorkspaceMember } from "./helpers/auth";
import { enrollVerifiedTotp } from "./helpers/totp";

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

test("Managers claim Reviews and Admins bulk-assign a filtered queue", async ({
  page,
}) => {
  const password = `Test-${crypto.randomUUID()}!`;
  const adminEmail = `assignment-admin-${crypto.randomUUID()}@example.com`;
  const firstManagerEmail = `assignment-manager-a-${crypto.randomUUID()}@example.com`;
  const secondManagerEmail = `assignment-manager-b-${crypto.randomUUID()}@example.com`;
  const ownerEmail = `assignment-owner-${crypto.randomUUID()}@example.com`;
  const users = await Promise.all(
    [adminEmail, firstManagerEmail, secondManagerEmail, ownerEmail].map(
      async (email) => {
        const { data, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });
        if (error) throw error;
        return data.user;
      }
    )
  );
  const [adminUser, firstManager, secondManager, owner] = users;
  const callIds: string[] = [];

  try {
    const { error: membershipError } = await admin
      .from("workspace_members")
      .insert([
        {
          workspace_id: workspaceId,
          user_id: adminUser.id,
          role: "admin",
        },
        {
          workspace_id: workspaceId,
          user_id: firstManager.id,
          role: "manager",
        },
        {
          workspace_id: workspaceId,
          user_id: secondManager.id,
          role: "manager",
        },
        {
          workspace_id: workspaceId,
          user_id: owner.id,
          role: "member",
        },
      ]);
    if (membershipError) throw membershipError;

    const callTitles = [
      `Claim queue ${crypto.randomUUID()}`,
      `Bulk queue A ${crypto.randomUUID()}`,
      `Bulk queue B ${crypto.randomUUID()}`,
    ];
    for (const title of callTitles) {
      const id = crypto.randomUUID();
      callIds.push(id);
      const { error } = await admin.from("calls").insert({
        id,
        workspace_id: workspaceId,
        owner_id: owner.id,
        title,
        source_mode: "both",
        status: "ready",
        chunk_prefix: `${workspaceId}/${id}/chunks`,
        recording_attested_by: owner.id,
        recording_attested_at: new Date().toISOString(),
      });
      if (error) throw error;
    }

    const managerClient = createClient(
      localUrl,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "integration-test-anon-key",
      { auth: { persistSession: false } }
    );
    const { error: managerSignInError } =
      await managerClient.auth.signInWithPassword({
        email: firstManagerEmail,
        password,
      });
    if (managerSignInError) throw managerSignInError;
    const { secret: managerTotpSecret } =
      await enrollVerifiedTotp(managerClient);

    await signInAsWorkspaceMember(
      page,
      firstManagerEmail,
      password,
      2,
      managerTotpSecret
    );
    await page.goto("/workspace");
    const claimedRow = page
      .locator(".review-queue-row")
      .filter({ hasText: callTitles[0] });
    await claimedRow.getByRole("button", { name: "Claim Review" }).click();
    await expect(
      page.locator(".review-queue-row").filter({ hasText: callTitles[0] })
    ).toHaveCount(0);

    await page.evaluate(() => window.localStorage.clear());
    await page.context().clearCookies();
    const adminClient = createClient(
      localUrl,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "integration-test-anon-key",
      { auth: { persistSession: false } }
    );
    const { error: adminSignInError } =
      await adminClient.auth.signInWithPassword({
        email: adminEmail,
        password,
      });
    if (adminSignInError) throw adminSignInError;
    const { secret: adminTotpSecret } = await enrollVerifiedTotp(adminClient);
    await signInAsWorkspaceMember(
      page,
      adminEmail,
      password,
      2,
      adminTotpSecret
    );
    await page.goto("/workspace");

    await page.getByLabel("Select filtered Calls").check();
    await page
      .getByLabel("Bulk Review Assignee")
      .selectOption(secondManager.id);
    await page.getByRole("button", { name: "Assign selected" }).click();
    await expect(
      page.locator(".review-queue-row").filter({ hasText: callTitles[1] })
    ).toHaveCount(0);
    await expect(
      page.locator(".review-queue-row").filter({ hasText: callTitles[2] })
    ).toHaveCount(0);

    await page.getByLabel("Review queue filter").selectOption("all");
    const reassignedRow = page
      .locator(".review-queue-row")
      .filter({ hasText: callTitles[1] });
    await expect(reassignedRow).toContainText(secondManagerEmail.split("@")[0]);
    await reassignedRow
      .getByLabel(`Review Assignee for ${callTitles[1]}`)
      .selectOption(firstManager.id);
    const reassignmentResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/reviews/assignments") &&
        response.request().method() === "POST"
    );
    await reassignedRow.getByRole("button", { name: "Reassign" }).click();
    const reassignmentResult = await reassignmentResponse;
    expect(reassignmentResult.status(), await reassignmentResult.text()).toBe(
      200
    );

    const { data: assignments, error: assignmentReadError } = await admin
      .from("call_review_assignments")
      .select("call_id, assignee_id, version")
      .in("call_id", callIds);
    if (assignmentReadError) throw assignmentReadError;
    expect(assignments).toHaveLength(3);
    expect(
      assignments?.find((assignment) => assignment.call_id === callIds[0])
    ).toMatchObject({ assignee_id: firstManager.id, version: 1 });
    expect(
      assignments?.find((assignment) => assignment.call_id === callIds[1])
    ).toMatchObject({ assignee_id: firstManager.id, version: 2 });
    expect(
      assignments?.find((assignment) => assignment.call_id === callIds[2])
    ).toMatchObject({ assignee_id: secondManager.id, version: 1 });
  } finally {
    if (callIds.length) await admin.from("calls").delete().in("id", callIds);
    for (const user of users) {
      const { error } = await admin.auth.admin.deleteUser(user.id);
      if (error) throw error;
    }
  }
});
