import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { signInAsWorkspaceMember } from "./helpers/auth";

const localUrl = "http://127.0.0.1:54321";
const localServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const admin = createClient(localUrl, localServiceRoleKey, {
  auth: { persistSession: false },
});

test.skip(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY,
  "requires the local Supabase stack"
);

test("password sign-in reports rejected credentials", async ({ page }) => {
  await expect(
    signInAsWorkspaceMember(
      page,
      `missing-${crypto.randomUUID()}@example.com`,
      `Invalid-${crypto.randomUUID()}!`
    )
  ).rejects.toThrow(
    /Supabase password sign-in failed \(400\).*invalid_credentials/
  );
  await expect(page.locator(".form-error")).toHaveText(
    "Invalid login credentials"
  );
  await expect(page).toHaveURL(/\/login$/);
});

test("protected navigation reports missing Workspace membership", async ({
  page,
}) => {
  const email = `non-member-${crypto.randomUUID()}@example.com`;
  const password = `Test-${crypto.randomUUID()}!`;
  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createError) throw createError;

  try {
    await expect(
      signInAsWorkspaceMember(page, email, password)
    ).rejects.toThrow(
      /server did not authorize \/record.*redirected to \/login.*Workspace membership/
    );
  } finally {
    await admin.auth.admin.deleteUser(created.user.id);
  }
});
