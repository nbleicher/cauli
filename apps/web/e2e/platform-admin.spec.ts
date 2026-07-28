import { createClient, type User } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { totpCode } from "./helpers/totp";

const localUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const admin = createClient(localUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

test.skip(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY,
  "requires the local Supabase stack"
);

test("Platform Admin signs in through the separate MFA control plane", async ({
  page,
  request,
}) => {
  const password = `Platform-${crypto.randomUUID()}!`;
  const email = `platform-browser-${crypto.randomUUID()}@example.com`;
  let user: User | undefined;

  try {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    user = data.user;
    const { error: identityError } = await admin
      .from("platform_admins")
      .insert({ user_id: user.id, environment: "staging" });
    if (identityError) throw identityError;

    const deniedWorkspaceHost = await request.get("/platform-admin", {
      headers: { host: "app.cauli.pro" },
    });
    expect(deniedWorkspaceHost.status()).toBe(404);

    await page.goto("/platform-login");
    await expect(
      page.getByRole("heading", { name: "Platform Admin" })
    ).toBeVisible();
    await page.getByLabel("Platform Admin email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page
      .getByRole("button", { name: "Sign in to control plane" })
      .click();

    await expect(page).toHaveURL(
      /\/auth\/mfa\?enroll=required&platform=1&next=\/platform-admin$/,
      { timeout: 15_000 }
    );
    const secret = (
      await page.locator(".mfa-secret code").textContent()
    )?.trim();
    expect(secret).toBeTruthy();
    await page.getByLabel("Verification code").fill(totpCode(secret!));
    await page.getByRole("button", { name: "Confirm and continue" }).click();

    await expect(page).toHaveURL(/\/platform-admin$/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Workspace health" })
    ).toBeVisible();
    await expect(page.getByRole("cell", { name: "cauli" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Record" })).toHaveCount(0);
    await expect(
      page.getByText("Workspace Admin", { exact: true })
    ).toHaveCount(0);

    const { data: audit, error: auditError } = await admin
      .from("audit_events")
      .select("action")
      .eq("actor_id", user.id);
    if (auditError) throw auditError;
    expect(audit.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "platform_admin.mfa.enrollment_started",
        "platform_admin.mfa.enrolled",
        "platform_admin.session.started",
        "platform_admin.health.inspected",
      ])
    );
  } finally {
    if (user) {
      await admin.auth.admin.deleteUser(user.id);
    }
  }
});
