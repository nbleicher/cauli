import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { signInAsWorkspaceMember } from "./helpers/auth";
import { enrollVerifiedTotp } from "./helpers/totp";

const localUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
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

test("a Manager pages, filters, and searches more than 250 Calls", async ({
  page,
}) => {
  const email = `discovery-${crypto.randomUUID()}@example.com`;
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
        role: "manager",
      });
    if (membershipError) throw membershipError;

    const base = Date.parse("2026-06-01T00:00:00.000Z");
    const rows = Array.from({ length: 260 }, (_unused, index) => {
      const callId = crypto.randomUUID();
      return {
        id: callId,
        workspace_id: workspaceId,
        owner_id: created.user.id,
        title: `Discovery call ${String(index).padStart(3, "0")}`,
        source_mode: "mic" as const,
        status: index === 7 ? ("failed" as const) : ("ready" as const),
        chunk_prefix: `${workspaceId}/${callId}/chunks`,
        started_at: new Date(base + index * 60_000).toISOString(),
        recording_attested_by: created.user.id,
        recording_attested_at: new Date(base).toISOString(),
      };
    });
    const { error: seedError } = await admin.from("calls").insert(rows);
    if (seedError) throw seedError;
    const { error: assignmentError } = await admin
      .from("call_review_assignments")
      .insert({
        call_id: rows[7]!.id,
        workspace_id: workspaceId,
        assignee_id: created.user.id,
        assigned_by: created.user.id,
      });
    if (assignmentError) throw assignmentError;

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
    await page.goto("/workspace");

    // Fifty per page, newest first.
    const rowLocator = page.locator(".data-table tbody tr");
    // Scoped to the pagination control: Next.js's dev overlay also has a
    // button whose name starts with "Next".
    const pager = page.getByRole("navigation", { name: "Call pages" });
    await expect(rowLocator).toHaveCount(50);
    await expect(page.getByText("50 Calls on this page")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Discovery call 259/ })
    ).toBeVisible();
    await expect(
      pager.getByRole("button", { name: "Previous" })
    ).toBeDisabled();

    await pager.getByRole("button", { name: "Next" }).click();
    await expect(rowLocator).toHaveCount(50);
    // Page two starts where page one ended, with no repeat and no gap.
    await expect(
      page.getByRole("link", { name: /Discovery call 209/ })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Discovery call 210/ })
    ).toHaveCount(0);

    await pager.getByRole("button", { name: "Previous" }).click();
    await expect(
      page.getByRole("link", { name: /Discovery call 259/ })
    ).toBeVisible();

    // Metadata search on the title.
    await page.getByLabel("Search Calls").fill("Discovery call 042");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(rowLocator).toHaveCount(1);
    await expect(
      page.getByRole("link", { name: /Discovery call 042/ })
    ).toBeVisible();

    // Combined with a processing-state filter that excludes it.
    await page.getByLabel("Processing").selectOption("failed");
    await expect(page.getByText("No matching calls")).toBeVisible();

    // Clearing puts the whole list back before the next question is asked.
    await page.getByRole("button", { name: /Clear filters/ }).click();
    await expect(rowLocator).toHaveCount(50);
    await expect(page.getByLabel("Processing")).toHaveValue("");

    // Owner and assignee filters name a specific Workspace member, rather than
    // collapsing every manager question into "mine".
    await page.getByLabel("Owner").selectOption(created.user.id);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("owner"))
      .toBe(created.user.id);
    await expect(rowLocator).toHaveCount(50);
    await page.getByRole("button", { name: /Clear filters/ }).click();

    await page.getByLabel("Assignment").selectOption(created.user.id);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("assignment"))
      .toBe(created.user.id);
    await expect(rowLocator).toHaveCount(1);
    await expect(
      page.getByRole("link", { name: /Discovery call 007/ })
    ).toBeVisible();
    await page.getByRole("button", { name: /Clear filters/ }).click();

    // The processing-state filter alone matches exactly one seeded Call.
    await page.getByLabel("Processing").selectOption("failed");
    await expect(rowLocator).toHaveCount(1);
    await expect(
      page.getByRole("link", { name: /Discovery call 007/ })
    ).toBeVisible();

    // A filter change drops the cursor rather than keeping page two of a
    // question nobody is asking any more.
    expect(new URL(page.url()).searchParams.get("cursor")).toBeNull();
  } finally {
    await admin.from("calls").delete().eq("owner_id", created.user.id);
    await admin
      .from("workspace_members")
      .delete()
      .eq("user_id", created.user.id);
    await admin.auth.admin.deleteUser(created.user.id);
  }
});
