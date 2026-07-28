import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { signInAsWorkspaceMember } from "./helpers/auth";
import { enrollVerifiedTotp } from "./helpers/totp";

const localUrl = "http://127.0.0.1:54321";
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "integration-test-anon-key";
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

test("Workspace navigation uses canonical language and preserves legacy URLs", async ({
  page,
}) => {
  const email = `workspace-navigation-${crypto.randomUUID()}@example.com`;
  const password = `Test-${crypto.randomUUID()}!`;
  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createError) throw createError;

  try {
    const { error: membershipError } = await admin
      .from("workspace_members")
      .insert({
        workspace_id: "00000000-0000-0000-0000-000000000001",
        user_id: created.user.id,
        role: "admin",
      });
    if (membershipError) throw membershipError;

    const userClient = createClient(localUrl, anonKey, {
      auth: { persistSession: false },
    });
    const { error: signInError } = await userClient.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;
    const { secret } = await enrollVerifiedTotp(userClient);

    await signInAsWorkspaceMember(page, email, password, 2, secret);
    await expect(
      page.getByRole("link", { name: "Workspace Calls" })
    ).toHaveAttribute("href", "/workspace");
    await expect(
      page.getByRole("link", { name: "Workspace Admin" })
    ).toHaveAttribute("href", "/admin/workspace");

    await page.goto("/team");
    await expect(page).toHaveURL(/\/workspace$/);
    await page.goto("/admin/team");
    await expect(page).toHaveURL(/\/admin\/workspace$/);
  } finally {
    await admin.auth.admin.deleteUser(created.user.id);
  }
});
