import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { signInAsWorkspaceMember } from "./helpers/auth";
import {
  installBrowserIdentity,
  installFakeMediaCapture,
} from "./helpers/fake-media";
import { enrollVerifiedTotp } from "./helpers/totp";

const localUrl = "http://127.0.0.1:54321";
const localServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const workspaceId = "00000000-0000-0000-0000-000000000001";

const admin = createClient(localUrl, localServiceRoleKey, {
  auth: { persistSession: false },
});

async function cleanupRecordingUser(userId: string) {
  const { data: calls, error: callLookupError } = await admin
    .from("calls")
    .select("id")
    .eq("owner_id", userId);
  if (callLookupError) throw callLookupError;
  const callIds = (calls ?? []).map((call) => call.id);
  if (callIds.length) {
    const { error: jobError } = await admin
      .from("processing_jobs")
      .delete()
      .in("call_id", callIds);
    if (jobError) throw jobError;
    const { error: callError } = await admin
      .from("calls")
      .delete()
      .in("id", callIds);
    if (callError) throw callError;
  }
  const { error: userError } = await admin.auth.admin.deleteUser(userId);
  if (userError) throw userError;
}

test.skip(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY,
  "requires the local Supabase stack"
);

test("Both mode continues degraded after one source ends and saves the recording", async ({
  page,
}) => {
  const email = `recording-${crypto.randomUUID()}@example.com`;
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
        role: "member",
      });
    if (membershipError) throw membershipError;

    await installFakeMediaCapture(page);

    await signInAsWorkspaceMember(page, email, password);

    await expect(
      page.getByText("Transcript generation is English-only.")
    ).toBeVisible();
    await page.getByLabel("Call title (optional)").fill("Customer discovery");
    await expect(
      page.getByRole("button", { name: "Start recording" })
    ).toBeDisabled();
    await page
      .getByLabel(/I confirm that I obtained all required notices/i)
      .check();
    await page.getByRole("button", { name: "Start recording" }).click();
    await expect(
      page.getByRole("button", { name: "Stop and save" })
    ).toBeVisible();

    await page.evaluate(() => {
      const media = (
        window as unknown as {
          __cauliMedia: { end(source: "mic" | "tab"): void };
        }
      ).__cauliMedia;
      media.end("mic");
    });
    await expect(
      page.getByText("Recording remaining audio · Degraded")
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop and save" })
    ).toBeVisible();

    await page.getByRole("button", { name: "Stop and save" }).click();
    await expect(page.getByText("Queued for processing")).toBeVisible({
      timeout: 15_000,
    });

    const { data: call, error: callError } = await admin
      .from("calls")
      .select(
        "degraded, degraded_intervals, status, source_mode, title, recording_attested_by, recording_attested_at"
      )
      .eq("owner_id", created.user.id)
      .single();
    if (callError) throw callError;
    expect(call).toMatchObject({
      degraded: true,
      source_mode: "both",
      status: "queued",
      title: "Customer discovery",
      recording_attested_by: created.user.id,
    });
    expect(call.recording_attested_at).not.toBeNull();
    expect(call.degraded_intervals).toHaveLength(1);
  } finally {
    await cleanupRecordingUser(created.user.id);
  }
});

test("leaving the Record page stops capture and retains an Incomplete Recording", async ({
  page,
}) => {
  const email = `recording-unmount-${crypto.randomUUID()}@example.com`;
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
        role: "member",
      });
    if (membershipError) throw membershipError;

    await installFakeMediaCapture(page);
    await signInAsWorkspaceMember(page, email, password);
    await page
      .getByLabel(/I confirm that I obtained all required notices/i)
      .check();
    await page.getByRole("button", { name: "Start recording" }).click();
    await expect(
      page.getByRole("button", { name: "Stop and save" })
    ).toBeVisible();

    await page.getByRole("link", { name: "My Calls" }).click();
    await expect(page).toHaveURL(/\/calls$/);

    const captureState = await page.evaluate(() =>
      (
        window as unknown as {
          __cauliMedia: {
            state(): { recorderState: string; liveAudioTracks: number };
          };
        }
      ).__cauliMedia.state()
    );
    expect(captureState).toEqual({
      recorderState: "inactive",
      liveAudioTracks: 0,
    });

    await page.goto("/record");
    await expect(
      page.getByRole("heading", {
        name: "Incomplete Recordings",
      })
    ).toBeVisible();
    await expect(page.getByText(/chunk 1$/)).toBeVisible();
  } finally {
    await cleanupRecordingUser(created.user.id);
  }
});

test("Chrome desktop on Windows is recognized as a supported recording surface", async ({
  page,
}) => {
  const email = `recording-windows-${crypto.randomUUID()}@example.com`;
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
        role: "member",
      });
    if (membershipError) throw membershipError;

    await installFakeMediaCapture(page, { platform: "windows" });
    await signInAsWorkspaceMember(page, email, password);

    await expect(
      page.getByLabel(/I confirm that I obtained all required notices/i)
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start recording" })
    ).toBeVisible();
  } finally {
    await cleanupRecordingUser(created.user.id);
  }
});

test("other current desktop browsers retain non-recording product navigation", async ({
  browser,
}) => {
  const email = `recording-unsupported-${crypto.randomUUID()}@example.com`;
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
        role: "member",
      });
    if (membershipError) throw membershipError;

    const unsupportedBrowsers = [
      { browser: "edge" as const, platform: "windows" as const },
      { browser: "firefox" as const, platform: "windows" as const },
      { browser: "safari" as const, platform: "macOS" as const },
    ];

    for (const identity of unsupportedBrowsers) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await installBrowserIdentity(page, identity);
        await signInAsWorkspaceMember(page, email, password);

        await expect(
          page.getByText(
            "Recording is available in Google Chrome on a macOS or Windows desktop."
          )
        ).toBeVisible();
        await expect(
          page.getByText(
            /You can still use Calls, Reviews, and account settings/i
          )
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Start recording" })
        ).toHaveCount(0);
        await expect(
          page.getByRole("link", { name: "My Calls" })
        ).toBeVisible();
        await expect(page.getByRole("link", { name: "Account" })).toBeVisible();
      } finally {
        await context.close();
      }
    }
  } finally {
    await cleanupRecordingUser(created.user.id);
  }
});

test("the Call owner can rename after capture while a Manager cannot", async ({
  browser,
  page,
}) => {
  const ownerEmail = `recording-owner-${crypto.randomUUID()}@example.com`;
  const managerEmail = `recording-manager-${crypto.randomUUID()}@example.com`;
  const ownerPassword = `Owner-${crypto.randomUUID()}!`;
  const managerPassword = `Manager-${crypto.randomUUID()}!`;
  const [
    { data: owner, error: ownerError },
    { data: manager, error: managerError },
  ] = await Promise.all([
    admin.auth.admin.createUser({
      email: ownerEmail,
      password: ownerPassword,
      email_confirm: true,
    }),
    admin.auth.admin.createUser({
      email: managerEmail,
      password: managerPassword,
      email_confirm: true,
    }),
  ]);
  if (ownerError) throw ownerError;
  if (managerError) throw managerError;

  let callId = "";
  const managerContext = await browser.newContext();
  try {
    const { error: membershipError } = await admin
      .from("workspace_members")
      .insert([
        {
          workspace_id: workspaceId,
          user_id: owner.user.id,
          role: "member",
        },
        {
          workspace_id: workspaceId,
          user_id: manager.user.id,
          role: "manager",
        },
      ]);
    if (membershipError) throw membershipError;

    const managerClient = createClient(
      localUrl,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "integration-test-anon-key",
      { auth: { persistSession: false } }
    );
    const { error: managerSignInError } =
      await managerClient.auth.signInWithPassword({
        email: managerEmail,
        password: managerPassword,
      });
    if (managerSignInError) throw managerSignInError;
    const { secret: managerTotpSecret } =
      await enrollVerifiedTotp(managerClient);

    const { data: call, error: callError } = await admin
      .from("calls")
      .insert({
        workspace_id: workspaceId,
        owner_id: owner.user.id,
        source_mode: "both",
        status: "ready",
        stopped_at: new Date().toISOString(),
        title: "Original title",
        chunk_prefix: `${workspaceId}/${crypto.randomUUID()}/chunks`,
        recording_attested_by: owner.user.id,
        recording_attested_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (callError) throw callError;
    callId = call.id;

    await signInAsWorkspaceMember(page, ownerEmail, ownerPassword);
    await page.goto(`/calls/${callId}`);
    await page.getByLabel("Call title").fill("Customer discovery");
    await page.getByRole("button", { name: "Save title" }).click();
    await expect(
      page.getByRole("heading", { name: "Customer discovery" })
    ).toBeVisible();

    const managerPage = await managerContext.newPage();
    await signInAsWorkspaceMember(
      managerPage,
      managerEmail,
      managerPassword,
      2,
      managerTotpSecret
    );
    await managerPage.goto(`/calls/${callId}`);
    await expect(
      managerPage.getByRole("heading", { name: "Customer discovery" })
    ).toBeVisible();
    await expect(managerPage.getByLabel("Call title")).toHaveCount(0);

    const denied = await managerPage.request.patch(`/api/calls/${callId}`, {
      data: { title: "Privileged rewrite" },
    });
    expect(denied.status()).toBe(404);
    const { data: persisted, error: persistedError } = await admin
      .from("calls")
      .select("title")
      .eq("id", callId)
      .single();
    if (persistedError) throw persistedError;
    expect(persisted.title).toBe("Customer discovery");
  } finally {
    await managerContext.close();
    if (callId) await admin.from("calls").delete().eq("id", callId);
    await admin.auth.admin.deleteUser(owner.user.id);
    await admin.auth.admin.deleteUser(manager.user.id);
  }
});
