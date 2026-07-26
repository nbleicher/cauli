import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { signInAsWorkspaceMember } from "./helpers/auth";

const localUrl = "http://127.0.0.1:54321";
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

    await page.addInitScript(() => {
      class FakeTrack extends EventTarget {
        kind: string;
        label: string;
        readyState = "live";

        constructor(kind: string, label: string) {
          super();
          this.kind = kind;
          this.label = label;
        }

        stop() {
          this.readyState = "ended";
        }

        end() {
          if (this.readyState === "ended") return;
          this.readyState = "ended";
          this.dispatchEvent(new Event("ended"));
        }
      }

      class FakeMediaStream {
        tracks: FakeTrack[];

        constructor(tracks: FakeTrack[] = []) {
          this.tracks = tracks;
        }

        getTracks() {
          return this.tracks;
        }

        getAudioTracks() {
          return this.tracks.filter((track) => track.kind === "audio");
        }

        getVideoTracks() {
          return this.tracks.filter((track) => track.kind === "video");
        }
      }

      const mic = new FakeTrack("audio", "Test microphone");
      const tab = new FakeTrack("audio", "Test call tab");
      const video = new FakeTrack("video", "Test call tab");
      const output = new FakeTrack("audio", "Mixed output");

      class FakeAudioContext {
        createMediaStreamDestination() {
          return { stream: new FakeMediaStream([output]) };
        }

        createMediaStreamSource() {
          return {
            connect() {
              return this;
            },
          };
        }

        createGain() {
          return {
            gain: { value: 1 },
            connect() {
              return this;
            },
          };
        }

        async resume() {}
        async close() {}
      }

      class FakeMediaRecorder extends EventTarget {
        static isTypeSupported() {
          return true;
        }

        mimeType: string;
        state = "inactive";

        constructor(_stream: FakeMediaStream, options?: { mimeType?: string }) {
          super();
          this.mimeType = options?.mimeType ?? "audio/webm";
        }

        start() {
          this.state = "recording";
        }

        stop() {
          this.state = "inactive";
          this.dispatchEvent(
            new MessageEvent("dataavailable", {
              data: new Blob(["recorded audio"], { type: this.mimeType }),
            })
          );
          this.dispatchEvent(new Event("stop"));
        }
      }

      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getDisplayMedia: async () => new FakeMediaStream([tab, video]),
          getUserMedia: async () => new FakeMediaStream([mic]),
        },
      });
      Object.defineProperty(window, "MediaStream", {
        configurable: true,
        value: FakeMediaStream,
      });
      Object.defineProperty(window, "MediaRecorder", {
        configurable: true,
        value: FakeMediaRecorder,
      });
      Object.defineProperty(window, "AudioContext", {
        configurable: true,
        value: FakeAudioContext,
      });
      Object.defineProperty(window, "__cauliMedia", {
        configurable: true,
        value: {
          end(source: "mic" | "tab") {
            (source === "mic" ? mic : tab).end();
          },
        },
      });
    });

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
    await expect(page.getByText("Queued for processing")).toBeVisible();

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
    await admin.from("calls").delete().eq("owner_id", created.user.id);
    await admin.auth.admin.deleteUser(created.user.id);
  }
});
