import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { signInAsWorkspaceMember } from "./helpers/auth";

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

test("Invitation Activation requires a new password before legal acceptance", async ({
  page,
}) => {
  const adminEmail = `activation-admin-${crypto.randomUUID()}@example.com`;
  const adminPassword = `Admin-${crypto.randomUUID()}!`;
  const invitedEmail = `activation-${crypto.randomUUID()}@example.com`;
  const temporaryPassword = `Temporary-${crypto.randomUUID()}!`;
  const newPassword = `Permanent-${crypto.randomUUID()}!`;
  const { data: workspaceAdmin, error: adminError } =
    await admin.auth.admin.createUser({
      email: adminEmail,
      password: adminPassword,
      email_confirm: true,
    });
  if (adminError) throw adminError;
  const { data: invited, error: invitedError } =
    await admin.auth.admin.createUser({
      email: invitedEmail,
      password: temporaryPassword,
      email_confirm: true,
    });
  if (invitedError) throw invitedError;

  try {
    const { error: adminMembershipError } = await admin
      .from("workspace_members")
      .insert({
        workspace_id: workspaceId,
        user_id: workspaceAdmin.user.id,
        role: "admin",
      });
    if (adminMembershipError) throw adminMembershipError;
    const inviteId = crypto.randomUUID();
    const { error: inviteError } = await admin
      .from("workspace_invites")
      .insert({
        id: inviteId,
        workspace_id: workspaceId,
        email: invitedEmail,
        role: "member",
        invited_by: workspaceAdmin.user.id,
      });
    if (inviteError) throw inviteError;

    const timestamp = new Date().toISOString();
    const version = `activation-${crypto
      .randomUUID()
      .replaceAll("-", "")
      .slice(0, 28)}`;
    const { data: documents, error: documentsError } = await admin
      .from("legal_documents")
      .select("id, document_type")
      .in("document_type", [
        "terms",
        "privacy",
        "dpa",
        "recording_responsibilities",
      ]);
    if (documentsError) throw documentsError;
    const { error: publishError } = await admin
      .from("legal_document_versions")
      .insert(
        documents.map((document) => {
          const content = `Activation test ${document.document_type}.`;
          return {
            document_id: document.id,
            version,
            content_markdown: content,
            content_sha256: createHash("sha256").update(content).digest("hex"),
            published_at: timestamp,
            effective_at: timestamp,
            operator_approved_at: timestamp,
            operator_approval_reference: "activation-browser-test",
          };
        })
      );
    if (publishError) throw publishError;
    const { error: gateError } = await admin
      .from("workspaces")
      .update({ legal_gate_required: true })
      .eq("id", workspaceId);
    if (gateError) throw gateError;

    await page.goto("/login");
    await expect(
      page.getByRole("button", { name: /email me a link/i })
    ).toHaveCount(0);
    await page.getByLabel("Work email").fill(invitedEmail);
    await page.getByLabel("Password").fill(temporaryPassword);
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes("/auth/v1/token") &&
          response.url().includes("grant_type=password") &&
          response.ok()
      ),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    await page.waitForTimeout(500);
    await page.goto(`/activate/password?invite=${inviteId}`);

    await page.getByLabel("New password").fill(newPassword);
    await page.getByLabel("Confirm password").fill(newPassword);
    const activationResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/auth/activate"
    );
    await page
      .getByRole("button", { name: "Create password and continue" })
      .click();
    const activationResponse = await activationResponsePromise;
    expect(activationResponse.ok()).toBe(true);
    await expect(page).toHaveURL(/\/legal\/acceptance$/, { timeout: 15_000 });

    const { data: acceptedInvite } = await admin
      .from("workspace_invites")
      .select("accepted_at")
      .eq("id", inviteId)
      .single();
    expect(acceptedInvite?.accepted_at).not.toBeNull();

    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Accept and continue" }).click();
    await expect(page).toHaveURL(/\/record$/);

    const oldPasswordClient = createClient(localUrl, anonKey, {
      auth: { persistSession: false },
    });
    const { error: oldPasswordError } =
      await oldPasswordClient.auth.signInWithPassword({
        email: invitedEmail,
        password: temporaryPassword,
      });
    expect(oldPasswordError).not.toBeNull();

    await page.context().clearCookies();
    await signInAsWorkspaceMember(page, invitedEmail, newPassword);
  } finally {
    await admin
      .from("workspaces")
      .update({ legal_gate_required: false })
      .eq("id", workspaceId);
    const { error: inviteCleanupError } = await admin
      .from("workspace_invites")
      .delete()
      .eq("invited_by", workspaceAdmin.user.id);
    if (inviteCleanupError) throw inviteCleanupError;
    const { error: invitedCleanupError } = await admin.auth.admin.deleteUser(
      invited.user.id
    );
    if (invitedCleanupError) throw invitedCleanupError;
    const { error: adminCleanupError } = await admin.auth.admin.deleteUser(
      workspaceAdmin.user.id
    );
    if (adminCleanupError) throw adminCleanupError;
  }
});
