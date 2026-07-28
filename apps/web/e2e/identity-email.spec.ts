import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { signInAsWorkspaceMember } from "./helpers/auth";
import { emailLinks, waitForEmail } from "./helpers/mailpit";

const localUrl = "http://127.0.0.1:54321";
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "integration-test-anon-key";
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const workspaceId = "00000000-0000-0000-0000-000000000001";
const admin = createClient(localUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

test.skip(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    process.env.RUN_IDENTITY_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY,
  "requires local Supabase, Mailpit, and the identity Edge Function"
);

async function createMember(
  email: string,
  password: string,
  role: "admin" | "manager" | "member"
) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  const { error: membershipError } = await admin
    .from("workspace_members")
    .insert({ workspace_id: workspaceId, user_id: data.user.id, role });
  if (membershipError) throw membershipError;
  return data.user;
}

async function removeUser(userId: string) {
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error && !/not found/i.test(error.message)) throw error;
}

test("delivered invitation proves email ownership and creates the password", async ({
  page,
}) => {
  const adminEmail = `mail-admin-${crypto.randomUUID()}@example.com`;
  const adminPassword = `Admin-${crypto.randomUUID()}!`;
  const invitedEmail = `mail-invite-${crypto.randomUUID()}@example.com`;
  const invitedPassword = `Permanent-${crypto.randomUUID()}!`;
  const workspaceAdmin = await createMember(adminEmail, adminPassword, "admin");
  let invitedUserId: string | undefined;

  try {
    await signInAsWorkspaceMember(page, adminEmail, adminPassword);
    const invitation = await page.evaluate(async (email) => {
      const response = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: "member" }),
      });
      return {
        status: response.status,
        body: (await response.json()) as { inviteId?: string; error?: string },
      };
    }, invitedEmail);
    expect(invitation.status, invitation.body.error).toBe(201);
    expect(invitation.body.inviteId).toBeTruthy();

    const email = await waitForEmail(invitedEmail);
    const invitationLink = emailLinks(email).find((link) =>
      link.includes("/auth/v1/verify")
    );
    expect(invitationLink).toBeTruthy();

    await page.context().clearCookies();
    await page.goto(invitationLink!);
    await expect(page).toHaveURL(
      new RegExp(`/activate/password\\?invite=${invitation.body.inviteId}$`),
      { timeout: 15_000 }
    );
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
    await page.getByLabel("New password").fill(invitedPassword);
    await page.getByLabel("Confirm password").fill(invitedPassword);
    const activationResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/auth/activate"
    );
    await page
      .getByRole("button", { name: "Create password and continue" })
      .click();
    const activationResponse = await activationResponsePromise;
    expect(activationResponse.status()).toBe(200);
    await expect(page).toHaveURL(/\/record$/, { timeout: 15_000 });

    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("id")
      .eq("email", invitedEmail)
      .single();
    if (profileError) throw profileError;
    invitedUserId = profile.id;

    const passwordClient = createClient(localUrl, anonKey, {
      auth: { persistSession: false },
    });
    const { error: loginError } = await passwordClient.auth.signInWithPassword({
      email: invitedEmail,
      password: invitedPassword,
    });
    expect(loginError).toBeNull();

    const { data: audit } = await admin
      .from("audit_events")
      .select("action")
      .eq("entity_id", invitation.body.inviteId);
    expect(audit?.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "workspace.invite.created",
        "workspace.invite.activated",
      ])
    );
  } finally {
    await admin
      .from("workspace_invites")
      .delete()
      .eq("invited_by", workspaceAdmin.id);
    if (invitedUserId) await removeUser(invitedUserId);
    await removeUser(workspaceAdmin.id);
  }
});

test("forgot password is neutral and the delivered link replaces the password", async ({
  page,
}) => {
  const email = `mail-reset-${crypto.randomUUID()}@example.com`;
  const oldPassword = `Old-${crypto.randomUUID()}!`;
  const newPassword = `New-${crypto.randomUUID()}!`;
  const member = await createMember(email, oldPassword, "member");

  try {
    await page.goto("/login");
    await page.getByLabel("Work email").fill(email);
    await page.getByRole("button", { name: "Forgot password?" }).click();
    await expect(page.getByRole("status")).toContainText(
      "If an account exists"
    );

    const message = await waitForEmail(email);
    const resetLink = emailLinks(message).find((link) =>
      link.includes("/auth/v1/verify")
    );
    expect(resetLink).toBeTruthy();
    await page.goto(resetLink!);
    await expect(page).toHaveURL(/\/auth\/password-reset$/, {
      timeout: 15_000,
    });
    await page.getByLabel("New password").fill(newPassword);
    await page.getByLabel("Confirm password").fill(newPassword);
    await page.getByRole("button", { name: "Save new password" }).click();
    await expect(page).toHaveURL(/\/record$/, { timeout: 15_000 });

    const oldClient = createClient(localUrl, anonKey, {
      auth: { persistSession: false },
    });
    expect(
      (
        await oldClient.auth.signInWithPassword({
          email,
          password: oldPassword,
        })
      ).error
    ).not.toBeNull();
    expect(
      (
        await oldClient.auth.signInWithPassword({
          email,
          password: newPassword,
        })
      ).error
    ).toBeNull();

    const { data: audit } = await admin
      .from("audit_events")
      .select("action")
      .eq("actor_id", member.id);
    expect(audit?.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "auth.password_reset.requested",
        "auth.password_reset.completed",
      ])
    );
  } finally {
    await removeUser(member.id);
  }
});
