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

test("an Admin sees Budget Paused work and its reason without being able to lift the limit", async ({
  page,
}) => {
  const email = `budget-${crypto.randomUUID()}@example.com`;
  const password = `Test-${crypto.randomUUID()}!`;
  const callId = crypto.randomUUID();
  const jobId = crypto.randomUUID();

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

    // An hour of audio and a one-cent budget: the pause is unavoidable.
    const { error: callError } = await admin.from("calls").insert({
      id: callId,
      workspace_id: workspaceId,
      owner_id: created.user.id,
      title: "Quarterly renewal call",
      source_mode: "mic",
      status: "queued",
      duration_ms: 3_600_000,
      chunk_prefix: `${workspaceId}/${callId}/chunks`,
      recording_attested_by: created.user.id,
      recording_attested_at: new Date().toISOString(),
    });
    if (callError) throw callError;
    const { error: jobError } = await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "process_recording",
      status: "queued",
      idempotency_key: `budget-journey:${callId}`,
    });
    if (jobError) throw jobError;
    const { error: budgetError } = await admin
      .from("workspace_processing_budget")
      .upsert({ workspace_id: workspaceId, daily_limit_usd: 0.01 });
    if (budgetError) throw budgetError;

    const { error: claimError } = await admin.rpc("claim_processing_job", {
      worker_name: "budget-journey-worker",
    });
    if (claimError) throw claimError;

    await signInAsWorkspaceMember(page, email, password, 2, secret);

    await page.goto(`/calls/${callId}`);
    await expect(page.locator(".status-budget_paused")).toHaveText(
      "budget paused"
    );
    await expect(
      page.getByText(/Your recording is safe and processing resumes/i)
    ).toBeVisible();
    // A pause is not a failure, so it must not offer a retry.
    await expect(
      page.getByRole("button", { name: "Retry processing" })
    ).toHaveCount(0);

    await page.goto("/admin/workspace");
    const budgetPanel = page
      .locator("section")
      .filter({ hasText: "Processing budget" });
    await expect(
      budgetPanel.getByText("Budgets are set by Cauli operators")
    ).toBeVisible();
    await expect(
      budgetPanel.getByText(/reached its daily processing budget/i)
    ).toBeVisible();
    await expect(
      budgetPanel.getByText("Recording and Source Audio are unaffected.")
    ).toBeVisible();
    // Read-only: the panel offers no control that changes a budget.
    await expect(budgetPanel.getByRole("button")).toHaveCount(0);

    // And the database refuses the same change if the browser is bypassed.
    const { error: denied } = await userClient.rpc(
      "set_workspace_processing_budget",
      { target_workspace_id: workspaceId, target_daily_limit_usd: 100 }
    );
    expect(denied?.message).toContain("Platform Admin");
  } finally {
    await admin.from("processing_jobs").delete().eq("id", jobId);
    await admin.from("calls").delete().eq("id", callId);
    await admin
      .from("workspace_processing_budget")
      .delete()
      .eq("workspace_id", workspaceId);
    await admin
      .from("processing_spend")
      .delete()
      .eq("workspace_id", workspaceId);
    await admin
      .from("processing_budget_warnings")
      .delete()
      .neq("scope_key", "");
    await admin
      .from("workspace_members")
      .delete()
      .eq("user_id", created.user.id);
    await admin.auth.admin.deleteUser(created.user.id);
  }
});
