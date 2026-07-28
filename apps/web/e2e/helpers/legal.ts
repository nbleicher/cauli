import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";

const requiredDocumentTypes = [
  "terms",
  "privacy",
  "dpa",
  "recording_responsibilities",
];

/**
 * Publishes an operator-approved current version of every core Legal Document
 * so the acceptance gate has something to require. Returns the version label.
 */
export async function publishCurrentLegalVersions(admin: SupabaseClient) {
  const version = `e2e-${crypto.randomUUID().replaceAll("-", "").slice(0, 32)}`;
  // Backdate slightly so effective_at is already in the past when the gate reads it.
  const timestamp = new Date(Date.now() - 1_000).toISOString();
  const { data: documents, error: documentsError } = await admin
    .from("legal_documents")
    .select("id, document_type")
    .in("document_type", requiredDocumentTypes);
  if (documentsError) throw documentsError;

  const { error: versionsError } = await admin
    .from("legal_document_versions")
    .insert(
      documents.map((document: { id: string; document_type: string }) => {
        const content = `Approved browser-test ${document.document_type} content ${version}.`;
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
  return version;
}

/** Accepts every currently required Legal Document Version from the gate page. */
export async function acceptCurrentLegalDocuments(page: Page) {
  await page.getByRole("checkbox").check();
  const acceptanceResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/legal/acceptance"
  );
  await page.getByRole("button", { name: "Accept and continue" }).click();
  expect((await acceptanceResponse).ok()).toBe(true);
}

/**
 * Invitation Activation always lands on the acceptance gate. The gate forwards
 * straight to the application when no current Legal Document Version is
 * outstanding, so tests that only care about reaching the application use this
 * to clear whichever state the surrounding suite left behind.
 */
export async function passLegalAcceptanceGate(page: Page) {
  await expect(page).toHaveURL(/\/(record|legal\/acceptance)$/, {
    timeout: 15_000,
  });
  if (new URL(page.url()).pathname === "/legal/acceptance") {
    await acceptCurrentLegalDocuments(page);
  }
  await expect(page).toHaveURL(/\/record$/, { timeout: 15_000 });
}
