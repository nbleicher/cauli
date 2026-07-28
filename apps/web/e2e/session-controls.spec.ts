import { createClient, type User } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

const localUrl = "http://127.0.0.1:54321";
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

async function createMember(email: string, password: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  const { error: membershipError } = await admin
    .from("workspace_members")
    .insert({
      workspace_id: workspaceId,
      user_id: data.user.id,
      role: "member",
    });
  if (membershipError) throw membershipError;
  return data.user;
}

async function removeUsers(users: User[]) {
  for (const user of users) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error && !/not found/i.test(error.message)) throw error;
  }
}

/** Ages the recorded session instead of waiting out the real threshold. */
async function ageSession(
  userId: string,
  column: "last_seen_at" | "started_at",
  agoMs: number
) {
  const { error } = await admin
    .from("session_activity")
    .update({ [column]: new Date(Date.now() - agoMs).toISOString() })
    .eq("user_id", userId);
  if (error) throw error;
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/auth/v1/token") &&
        response.url().includes("grant_type=password") &&
        response.ok()
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  await page.waitForURL(/\/(record|auth\/mfa|legal\/acceptance|login)/, {
    timeout: 15_000,
  });
}

const thirtyOneMinutes = 31 * 60_000;
const thirteenHours = 13 * 60 * 60_000;

test("an idle session locks, an active Recording is spared, and twelve hours ends it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const email = `session-${crypto.randomUUID()}@example.com`;
  const password = `Session-${crypto.randomUUID()}!`;
  const member = await createMember(email, password);

  try {
    await signIn(page, email, password);
    await expect(page).toHaveURL(/\/record$/, { timeout: 15_000 });

    await ageSession(member.id, "last_seen_at", thirtyOneMinutes);
    await page.goto("/record");
    await expect(page).toHaveURL(/\/login\?locked=inactivity$/, {
      timeout: 15_000,
    });
    await expect(page.getByRole("status")).toContainText(
      "locked after 30 minutes"
    );

    // Signing in again starts a new session that is immediately usable.
    await signIn(page, email, password);
    await expect(page).toHaveURL(/\/record$/, { timeout: 15_000 });

    // Capture suspends the threshold rather than resetting it.
    const callId = crypto.randomUUID();
    const { error: callError } = await admin.from("calls").insert({
      id: callId,
      workspace_id: workspaceId,
      owner_id: member.id,
      source_mode: "both",
      status: "recording",
      chunk_prefix: `${workspaceId}/${callId}/chunks`,
    });
    if (callError) throw callError;
    await ageSession(member.id, "last_seen_at", thirtyOneMinutes);
    await page.goto("/record");
    await expect(page).toHaveURL(/\/record$/, { timeout: 15_000 });

    // Stop & Save ends the exception and the elapsed threshold applies at once.
    const { error: stopError } = await admin
      .from("calls")
      .update({ status: "ready" })
      .eq("id", callId);
    if (stopError) throw stopError;
    await page.goto("/record");
    await expect(page).toHaveURL(/\/login\?locked=inactivity$/, {
      timeout: 15_000,
    });

    await signIn(page, email, password);
    await expect(page).toHaveURL(/\/record$/, { timeout: 15_000 });
    await ageSession(member.id, "started_at", thirteenHours);
    await page.goto("/record");
    await expect(page).toHaveURL(/\/login\?locked=absolute$/, {
      timeout: 15_000,
    });
    await expect(page.getByRole("status")).toContainText("12 hours");

    await admin.from("calls").delete().eq("id", callId);
  } finally {
    await removeUsers([member]);
  }
});

test("Call creation is throttled and the refusal reaches the browser", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const email = `throttle-${crypto.randomUUID()}@example.com`;
  const password = `Throttle-${crypto.randomUUID()}!`;
  const member = await createMember(email, password);

  try {
    await signIn(page, email, password);
    await expect(page).toHaveURL(/\/record$/, { timeout: 15_000 });

    const statuses = await page.evaluate(async () => {
      const seen: number[] = [];
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const response = await fetch("/api/calls", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceMode: "both" }),
        });
        seen.push(response.status);
      }
      return seen;
    });

    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses[10]).toBe(429);

    const { data: audit, error: auditError } = await admin
      .from("audit_events")
      .select("action, entity_id, metadata")
      .eq("action", "security.rate_limit.exceeded");
    if (auditError) throw auditError;
    expect(audit.map((event) => event.entity_id as string)).toContain(
      "call.create"
    );
    // Evidence names the limit, never the person who reached it.
    expect(JSON.stringify(audit)).not.toContain(member.id);
  } finally {
    await admin.from("calls").delete().eq("owner_id", member.id);
    await admin.from("rate_limit_state").delete().eq("bucket", "call.create");
    await removeUsers([member]);
  }
});
