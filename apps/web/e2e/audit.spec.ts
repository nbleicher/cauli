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

test("an Admin filters and exports immutable Audit Events", async ({
  page,
}) => {
  const email = `audit-${crypto.randomUUID()}@example.com`;
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
        workspace_id: workspaceId,
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

    const entityId = crypto.randomUUID();
    const { error: auditError } = await admin.rpc("record_audit_event", {
      target_workspace_id: workspaceId,
      target_actor_id: created.user.id,
      target_action: "workspace.test.created",
      target_entity_type: "workspace",
      target_entity_id: entityId,
      target_metadata: { test_run: true },
    });
    if (auditError) throw auditError;

    await signInAsWorkspaceMember(page, email, password, 2, secret);
    await page.getByRole("link", { name: "Audit Log" }).click();
    await expect(
      page.getByRole("heading", { name: "Audit Log" })
    ).toBeVisible();
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: entityId })
        .getByText("workspace.test.created")
    ).toBeVisible();

    await page.getByLabel("Action").fill("workspace.test.created");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByText(entityId)).toBeVisible();

    const exportResponse = await page.request.get(
      "/api/admin/audit/export?action=workspace.test.created"
    );
    expect(exportResponse.status()).toBe(200);
    expect(exportResponse.headers()["content-type"]).toContain("text/csv");
    expect(await exportResponse.text()).toContain("workspace.test.created");

    const { count } = await admin
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("action", "audit.export.created")
      .eq("actor_id", created.user.id);
    expect(count).toBe(1);
  } finally {
    await admin.auth.admin.deleteUser(created.user.id);
  }
});
