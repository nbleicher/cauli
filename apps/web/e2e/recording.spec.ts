import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { signInAsWorkspaceMember } from "./helpers/auth";
import { installFakeMediaCapture } from "./helpers/fake-media";

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
      .select("degraded, degraded_intervals, status, source_mode")
      .eq("owner_id", created.user.id)
      .single();
    if (callError) throw callError;
    expect(call).toMatchObject({
      degraded: true,
      source_mode: "both",
      status: "queued",
    });
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
