import { createClient, type User } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { signInAsWorkspaceMember } from "./helpers/auth";
import { passLegalAcceptanceGate } from "./helpers/legal";
import { passRecoveryCodeHandover } from "./helpers/recovery";
import { totpCode } from "./helpers/totp";

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
    !process.env.SUPABASE_SERVICE_ROLE_KEY,
  "requires the local Supabase stack"
);

async function createUser(
  role: "admin" | "manager" | "member",
  password: string
) {
  const email = `mfa-${role}-${crypto.randomUUID()}@example.com`;
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
  return { user: data.user, email };
}

async function removeUsers(users: User[]) {
  for (const user of users) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error && !/not found/i.test(error.message)) throw error;
  }
}

function invalidCode(secret: string) {
  const valid = totpCode(secret);
  const replacement = valid.endsWith("0") ? "1" : "0";
  return `${valid.slice(0, -1)}${replacement}`;
}

test("a Member can sign in without enrolling TOTP", async ({ page }) => {
  const password = `Member-${crypto.randomUUID()}!`;
  const member = await createUser("member", password);
  try {
    await signInAsWorkspaceMember(page, member.email, password);
    await expect(page).toHaveURL(/\/record$/);
  } finally {
    await removeUsers([member.user]);
  }
});

test("a role change to Manager enforces enrollment and retains the factor after downgrade", async ({
  page,
}) => {
  const password = `Manager-${crypto.randomUUID()}!`;
  const member = await createUser("member", password);

  try {
    await signInAsWorkspaceMember(page, member.email, password);
    const { error: roleError } = await admin
      .from("workspace_members")
      .update({ role: "manager" })
      .eq("workspace_id", workspaceId)
      .eq("user_id", member.user.id);
    if (roleError) throw roleError;

    await page.goto("/record");
    await expect(page).toHaveURL(/\/auth\/mfa\?enroll=required$/);
    const secret = (
      await page.locator(".mfa-secret code").textContent()
    )?.trim();
    expect(secret).toBeTruthy();

    await page.getByLabel("Verification code").fill(invalidCode(secret!));
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    await expect(page.getByText("code was not accepted")).toBeVisible();
    await expect(page.locator(".mfa-secret code")).toHaveText(secret!);

    await page.getByLabel("Verification code").fill(totpCode(secret!));
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    await passRecoveryCodeHandover(page);
    await expect(page).toHaveURL(/\/record$/, { timeout: 15_000 });
    await expect(page.locator(".mfa-secret code")).toHaveCount(0);

    const { error: downgradeError } = await admin
      .from("workspace_members")
      .update({ role: "member" })
      .eq("workspace_id", workspaceId)
      .eq("user_id", member.user.id);
    if (downgradeError) throw downgradeError;
    const { data: factors, error: factorsError } =
      await admin.auth.admin.mfa.listFactors({ userId: member.user.id });
    if (factorsError) throw factorsError;
    expect(factors.factors.some((factor) => factor.status === "verified")).toBe(
      true
    );

    const { data: audit, error: auditError } = await admin
      .from("audit_events")
      .select("action")
      .eq("entity_id", member.user.id);
    if (auditError) throw auditError;
    expect(audit.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "auth.mfa.role_enforced",
        "auth.mfa.enrollment_started",
        "auth.mfa.verification_failed",
        "auth.mfa.enrolled",
      ])
    );
  } finally {
    await removeUsers([member.user]);
  }
});

test("an Admin Invitation remains pending until TOTP is verified", async ({
  page,
}) => {
  const inviterPassword = `Inviter-${crypto.randomUUID()}!`;
  const invitedPassword = `Temporary-${crypto.randomUUID()}!`;
  const permanentPassword = `Permanent-${crypto.randomUUID()}!`;
  const inviter = await createUser("admin", inviterPassword);
  const invitedEmail = `mfa-invited-admin-${crypto.randomUUID()}@example.com`;
  const inviteId = crypto.randomUUID();
  let invitedUser: User | undefined;

  try {
    const { error: inviteError } = await admin
      .from("workspace_invites")
      .insert({
        id: inviteId,
        workspace_id: workspaceId,
        email: invitedEmail,
        role: "admin",
        invited_by: inviter.user.id,
      });
    if (inviteError) throw inviteError;
    const { data: invited, error: invitedError } =
      await admin.auth.admin.createUser({
        email: invitedEmail,
        password: invitedPassword,
        email_confirm: true,
      });
    if (invitedError) throw invitedError;
    invitedUser = invited.user;

    await page.goto("/login");
    await page.getByLabel("Work email").fill(invitedEmail);
    await page.getByLabel("Password").fill(invitedPassword);
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes("/auth/v1/token") &&
          response.url().includes("grant_type=password") &&
          response.ok()
      ),
      page.waitForURL((url) => url.pathname !== "/login"),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    await page.goto(`/activate/password?invite=${inviteId}`);
    await page.getByLabel("New password").fill(permanentPassword);
    await page.getByLabel("Confirm password").fill(permanentPassword);
    await page
      .getByRole("button", { name: "Create password and continue" })
      .click();

    await expect(page).toHaveURL(
      new RegExp(`/auth/mfa\\?enroll=required&invite=${inviteId}$`),
      { timeout: 15_000 }
    );
    const [{ data: pendingInvite }, { count: prematureMemberships }] =
      await Promise.all([
        admin
          .from("workspace_invites")
          .select("accepted_at")
          .eq("id", inviteId)
          .single(),
        admin
          .from("workspace_members")
          .select("user_id", { count: "exact", head: true })
          .eq("user_id", invited.user.id),
      ]);
    expect(pendingInvite?.accepted_at).toBeNull();
    expect(prematureMemberships).toBe(0);

    const secret = (
      await page.locator(".mfa-secret code").textContent()
    )?.trim();
    expect(secret).toBeTruthy();
    await page.getByLabel("Verification code").fill(totpCode(secret!));
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    await passRecoveryCodeHandover(page);
    await passLegalAcceptanceGate(page);

    const [{ data: acceptedInvite }, { data: membership }] = await Promise.all([
      admin
        .from("workspace_invites")
        .select("accepted_at")
        .eq("id", inviteId)
        .single(),
      admin
        .from("workspace_members")
        .select("role")
        .eq("user_id", invited.user.id)
        .single(),
    ]);
    expect(acceptedInvite?.accepted_at).not.toBeNull();
    expect(membership?.role).toBe("admin");
  } finally {
    await admin.from("workspace_invites").delete().eq("id", inviteId);
    if (invitedUser) await removeUsers([invitedUser]);
    await removeUsers([inviter.user]);
  }
});
