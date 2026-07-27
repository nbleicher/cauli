import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const localUrl = "http://127.0.0.1:54321";
const localServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const workspaceId = "00000000-0000-0000-0000-000000000001";
const regulatedUseDisclaimer =
  "Cauli’s pilot has not been independently assessed, certified, or contractually approved for HIPAA, PCI DSS, FedRAMP, CUI, FERPA, COPPA, GLBA, GDPR-specific, or similar regulated workloads.";
const admin = createClient(localUrl, localServiceRoleKey, {
  auth: { persistSession: false },
});

test.skip(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY,
  "requires the local Supabase stack"
);

test("an initial Admin accepts exact versions before using the application", async ({
  page,
}) => {
  const email = `legal-${crypto.randomUUID()}@example.com`;
  const password = `Test-${crypto.randomUUID()}!`;
  const version = `e2e-${crypto.randomUUID().replaceAll("-", "").slice(0, 32)}`;
  const timestamp = new Date().toISOString();
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
        is_initial_admin: true,
      });
    if (membershipError) throw membershipError;

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
    const { error: versionsError } = await admin
      .from("legal_document_versions")
      .insert(
        documents.map((document) => {
          const content = `Approved browser-test ${document.document_type} content.\n\n${regulatedUseDisclaimer}`;
          return {
            document_id: document.id,
            version,
            content_markdown: content,
            content_sha256: createHash("sha256").update(content).digest("hex"),
            is_material: true,
            published_at: timestamp,
            effective_at: timestamp,
            operator_approved_at: timestamp,
            operator_approval_reference: "browser-test-operator-approval",
          };
        })
      );
    if (versionsError) throw versionsError;
    const { error: gateError } = await admin
      .from("workspaces")
      .update({ legal_gate_required: true })
      .eq("id", workspaceId);
    if (gateError) throw gateError;

    await page.goto("/login");
    await page.getByLabel("Work email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/legal\/acceptance$/);

    const exactVersionLinks = page.locator(
      `.legal-version-list a[href*="version=${version}"]`
    );
    await expect(exactVersionLinks).toHaveCount(4);
    await expect(
      page
        .locator(".legal-acceptance-panel")
        .getByRole("link", { name: "Regulated-Use Disclaimer" })
    ).toHaveAttribute("href", "/legal/security");
    await expect(
      page
        .getByRole("navigation", { name: "Policy links" })
        .getByRole("link", { name: "Regulated-Use Disclaimer" })
    ).toHaveAttribute("href", "/legal/security");
    await expect(page.getByRole("checkbox")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Accept and continue" })
    ).toBeDisabled();

    const blockedResponse = await page.request.get("/api/admin/audit/export");
    expect(blockedResponse.status()).toBe(403);

    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Accept and continue" }).click();
    await expect(page).toHaveURL(/\/record$/);

    const { count, error: acceptanceError } = await admin
      .from("legal_acceptances")
      .select("id", { count: "exact", head: true })
      .eq("user_id", created.user.id);
    if (acceptanceError) throw acceptanceError;
    expect(count).toBe(4);
  } finally {
    await admin
      .from("workspaces")
      .update({ legal_gate_required: false })
      .eq("id", workspaceId);
    await admin.auth.admin.deleteUser(created.user.id);
  }
});

test("the regulated-use disclaimer is public and has no acceptance gate", async ({
  page,
}) => {
  await page.goto("/legal/security");
  await expect(page.getByText(regulatedUseDisclaimer)).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page).toHaveURL(/\/legal\/security$/);
});
