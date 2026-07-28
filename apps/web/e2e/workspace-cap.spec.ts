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

test("the Workspace Admin admits the tenth active member and rejects the eleventh", async ({
  page,
}) => {
  const password = `Test-${crypto.randomUUID()}!`;
  const createdUserIds: string[] = [];
  const emails: string[] = [];

  try {
    for (let index = 0; index < 11; index += 1) {
      const email = `pilot-seat-${index}-${crypto.randomUUID()}@example.com`;
      const { data: created, error: createError } =
        await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });
      if (createError) throw createError;
      createdUserIds.push(created.user.id);
      emails.push(email);

      const { error: membershipError } = await admin
        .from("workspace_members")
        .insert({
          workspace_id: workspaceId,
          user_id: created.user.id,
          role: index === 0 ? "admin" : "member",
          status: index < 9 ? "active" : "suspended",
        });
      if (membershipError) throw membershipError;
    }

    const adminClient = createClient(localUrl, anonKey, {
      auth: { persistSession: false },
    });
    const { error: signInError } = await adminClient.auth.signInWithPassword({
      email: emails[0],
      password,
    });
    if (signInError) throw signInError;
    const { secret } = await enrollVerifiedTotp(adminClient);
    await signInAsWorkspaceMember(page, emails[0], password, 2, secret);
    await page.goto("/admin/workspace");
    await expect(page.getByText("9 active members · 11 total")).toBeVisible();

    const tenthResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname.endsWith(
          `/api/admin/members/${createdUserIds[9]}`
        )
    );
    await page.getByLabel(`Status for ${emails[9]}`).selectOption("active");
    const tenthResponse = await tenthResponsePromise;
    expect(tenthResponse.ok()).toBe(true);
    await expect(page.getByText("10 active members · 11 total")).toBeVisible({
      timeout: 15_000,
    });

    const eleventhResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname.endsWith(
          `/api/admin/members/${createdUserIds[10]}`
        )
    );
    await page.getByLabel(`Status for ${emails[10]}`).selectOption("active");
    const eleventhResponse = await eleventhResponsePromise;
    expect(eleventhResponse.status()).toBe(409);
    await expect(page.locator(".error-banner")).toContainText(
      "limited to ten active Workspace Members",
      { timeout: 15_000 }
    );
    await expect(page.getByLabel(`Status for ${emails[10]}`)).toHaveValue(
      "suspended"
    );
  } finally {
    for (const userId of createdUserIds) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw error;
    }
  }
});
