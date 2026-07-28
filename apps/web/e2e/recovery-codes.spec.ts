import { createClient, type User } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { totpCode } from "./helpers/totp";

const localUrl = "http://127.0.0.1:54321";
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "integration-test-anon-key";
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const workspaceId = "00000000-0000-0000-0000-000000000001";
const codeFormat = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const admin = createClient(localUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

test.skip(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    process.env.RUN_IDENTITY_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY,
  "requires local Supabase and the identity Edge Function"
);

async function createMember(email: string, password: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  const { error: membershipError } = await admin
    .from("workspace_members")
    .insert({
      workspace_id: workspaceId,
      user_id: data.user.id,
      role: "member",
    });
  if (membershipError) throw membershipError;
  return data.user;
}

async function removeUsers(users: User[]) {
  for (const user of users) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error && !/not found/i.test(error.message)) throw error;
  }
}

async function signInWithPassword(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/auth/v1/token") &&
        response.url().includes("grant_type=password") &&
        response.ok()
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  // Sign-in navigates on its own; letting it land first keeps a following
  // page.goto from aborting the redirect underneath it.
  await page.waitForURL(/\/(record|auth\/mfa|legal\/acceptance)/, {
    timeout: 15_000,
  });
}

/** Enrolls from whichever screen is currently offering a QR code, then returns
 * the freshly issued Recovery Codes. */
async function enrollAndReadCodes(page: Page, confirmLabel: string) {
  const secret = (await page.locator(".mfa-secret code").textContent())?.trim();
  expect(secret).toBeTruthy();
  await page.getByLabel(/code/i).first().fill(totpCode(secret!));
  await page.getByRole("button", { name: confirmLabel }).click();
  const codeItems = page.locator(".recovery-code-list li");
  await expect(codeItems).toHaveCount(10, { timeout: 15_000 });
  return codeItems.allTextContents();
}

/** Returns the status the recovery endpoint answered with. */
async function attemptRecovery(page: Page, password: string, code: string) {
  await page.goto("/auth/recovery");
  await page.getByLabel("Password").fill(password);
  await page.getByLabel("Recovery Code").fill(code);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/auth/recovery",
    { timeout: 30_000 }
  );
  await page.getByRole("button", { name: "Replace my authenticator" }).click();
  return (await responsePromise).status();
}

test("a Recovery Code replaces an inaccessible authenticator and nothing more", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const email = `recovery-${crypto.randomUUID()}@example.com`;
  const password = `Recovery-${crypto.randomUUID()}!`;
  const member = await createMember(email, password);

  try {
    await signInWithPassword(page, email, password);
    await expect(page).toHaveURL(/\/record$/, { timeout: 15_000 });

    await page.goto("/account");
    await page
      .getByRole("button", { name: "Set up authenticator app" })
      .click();
    const firstCodes = await enrollAndReadCodes(page, "Confirm and enable");
    expect(firstCodes).toHaveLength(10);
    expect(new Set(firstCodes).size).toBe(10);
    for (const code of firstCodes) expect(code).toMatch(codeFormat);

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download" }).click();
    expect((await download).suggestedFilename()).toBe(
      "cauli-recovery-codes.txt"
    );
    await page.getByRole("button", { name: "Done" }).click();
    // The codes are held in component state only, so leaving loses them.
    await page.reload();
    await expect(page.locator(".recovery-code-list li")).toHaveCount(0);

    // A fresh password-only session cannot reach the application.
    await page.context().clearCookies();
    await signInWithPassword(page, email, password);
    await page.goto("/record");
    await expect(page).toHaveURL(/\/auth\/mfa(?:\?|$)/, { timeout: 15_000 });

    expect(await attemptRecovery(page, password, "ZZZZ-ZZZZ-ZZZZ")).toBe(401);
    await expect(page.locator(".form-error")).toContainText(
      "Recovery could not be verified"
    );
    // A valid code is still refused without the password.
    expect(
      await attemptRecovery(page, `${password}-wrong`, firstCodes[0])
    ).toBe(401);

    expect(await attemptRecovery(page, password, firstCodes[0])).toBe(200);
    await expect(page).toHaveURL(/\/auth\/mfa\?enroll=required$/, {
      timeout: 15_000,
    });

    // Redemption bought enrollment, not access.
    await page.goto("/record");
    await expect(page).toHaveURL(/\/auth\/mfa\?enroll=required$/, {
      timeout: 15_000,
    });
    expect(
      await page.evaluate(
        async () =>
          (
            await fetch("/api/calls", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            })
          ).status
      )
    ).toBe(401);

    // The same code cannot be presented twice.
    expect(await attemptRecovery(page, password, firstCodes[0])).toBe(401);

    await page.goto("/auth/mfa?enroll=required");
    const secondCodes = await enrollAndReadCodes(page, "Confirm and continue");
    expect(secondCodes).toHaveLength(10);
    expect(secondCodes.some((code) => firstCodes.includes(code))).toBe(false);
    await page
      .getByRole("button", { name: "I have saved these codes, continue" })
      .click();
    await expect(page).toHaveURL(/\/record$/, { timeout: 15_000 });

    // Every unused code from the retired set died with it.
    await page.context().clearCookies();
    await signInWithPassword(page, email, password);
    expect(await attemptRecovery(page, password, firstCodes[1])).toBe(401);

    const { data: audit, error: auditError } = await admin
      .from("audit_events")
      .select("action, metadata")
      .eq("entity_id", member.id);
    if (auditError) throw auditError;
    expect(audit.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "auth.mfa.recovery_codes_generated",
        "auth.mfa.recovery_codes_downloaded",
        "auth.mfa.recovery_used",
        "auth.mfa.recovery_failed",
        "auth.mfa.recovery_codes_regenerated",
      ])
    );
    const serializedAudit = JSON.stringify(audit);
    for (const code of [...firstCodes, ...secondCodes]) {
      expect(serializedAudit).not.toContain(code);
    }
  } finally {
    await removeUsers([member]);
  }
});
