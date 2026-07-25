import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
process.env.OPENROUTER_API_KEY = "config-key";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("transcribeAudioSegments", () => {
  it("classifies permanent provider failures so they are not retried or masked by fallback", async () => {
    const { classifyOpenRouterFailure } = await import("./transcribe.js");

    expect(classifyOpenRouterFailure(401, "Invalid API key")).toEqual({
      category: "authentication",
      retryable: false,
    });
    expect(classifyOpenRouterFailure(402, "Insufficient credits")).toEqual({
      category: "billing",
      retryable: false,
    });
    expect(classifyOpenRouterFailure(429, "Rate limited")).toEqual({
      category: "rate_limit",
      retryable: true,
    });
    expect(classifyOpenRouterFailure(503, "No provider available")).toEqual({
      category: "provider_unavailable",
      retryable: true,
    });
  });

  it("fails authentication once with structured chunk and generation metadata", async () => {
    const { transcribeAudioSegments } = await import("./transcribe.js");
    const directory = await mkdtemp(join(tmpdir(), "cauli-transcription-"));
    temporaryDirectories.push(directory);
    const audioPath = join(directory, "segment.mp3");
    await writeFile(audioPath, Buffer.from("audio fixture"));

    let attempts = 0;
    const result = transcribeAudioSegments([audioPath], {
      apiKey: "bad-key",
      fallbackModel: "openai/whisper-large-v3",
      fetch: async () => {
        attempts += 1;
        return new Response("Invalid API key", {
          status: 401,
          headers: { "X-Generation-Id": "generation-auth" },
        });
      },
      primaryModel: "openai/whisper-large-v3-turbo",
    });

    await expect(result).rejects.toMatchObject({
      category: "authentication",
      chunkIndex: 0,
      generationId: "generation-auth",
      retryable: false,
    });
    expect(attempts).toBe(1);
  });

  it("fails an empty successful response without retrying or falling back", async () => {
    const { transcribeAudioSegments } = await import("./transcribe.js");
    const directory = await mkdtemp(join(tmpdir(), "cauli-transcription-"));
    temporaryDirectories.push(directory);
    const audioPath = join(directory, "segment.mp3");
    await writeFile(audioPath, Buffer.from("silent fixture"));

    let attempts = 0;
    const result = transcribeAudioSegments([audioPath], {
      apiKey: "test-key",
      fetch: async () => {
        attempts += 1;
        return new Response(
          JSON.stringify({
            usage: { seconds: 10, cost: 0.0001 },
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "X-Generation-Id": "generation-empty",
            },
          }
        );
      },
    });

    await expect(result).rejects.toMatchObject({
      category: "malformed_response",
      chunkIndex: 0,
      generationId: "generation-empty",
      retryable: false,
    });
    expect(attempts).toBe(1);
  });

  it("transcribes English audio through OpenRouter with mandatory privacy controls", async () => {
    const { transcribeAudioSegments } = await import("./transcribe.js");

    const directory = await mkdtemp(join(tmpdir(), "cauli-transcription-"));
    temporaryDirectories.push(directory);
    const audioPath = join(directory, "segment.mp3");
    await writeFile(audioPath, Buffer.from("audio fixture"));

    const openRouterFetch: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toEqual({
        input_audio: {
          data: Buffer.from("audio fixture").toString("base64"),
          format: "mp3",
        },
        language: "en",
        model: "openai/whisper-large-v3-turbo",
        provider: {
          data_collection: "deny",
          zdr: true,
        },
      });
      return new Response(
        JSON.stringify({
          text: "Hello from the call",
          usage: { seconds: 12, cost: 0.0002 },
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "X-Generation-Id": "generation-1",
          },
        }
      );
    };

    const result = await transcribeAudioSegments([audioPath], {
      apiKey: "test-key",
      fetch: openRouterFetch,
      language: "en",
      primaryModel: "openai/whisper-large-v3-turbo",
    });

    expect(result).toMatchObject({
      text: "Hello from the call",
      durationSeconds: 12,
      costUsd: 0.0002,
      generationIds: ["generation-1"],
    });
  });

  it("honors Retry-After before retrying a transient OpenRouter failure", async () => {
    const { transcribeAudioSegments } = await import("./transcribe.js");
    const directory = await mkdtemp(join(tmpdir(), "cauli-transcription-"));
    temporaryDirectories.push(directory);
    const audioPath = join(directory, "segment.mp3");
    await writeFile(audioPath, Buffer.from("audio fixture"));

    let attempts = 0;
    const delays: number[] = [];
    const openRouterFetch: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(
          JSON.stringify({ error: { message: "Unavailable" } }),
          {
            status: 503,
            headers: { "Retry-After": "2" },
          }
        );
      }
      return new Response(
        JSON.stringify({
          text: "Recovered transcript",
          usage: { seconds: 8, cost: 0.0001 },
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    const result = await transcribeAudioSegments([audioPath], {
      apiKey: "test-key",
      fetch: openRouterFetch,
      language: "en",
      maxAttempts: 5,
      primaryModel: "openai/whisper-large-v3-turbo",
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(result.text).toBe("Recovered transcript");
    expect(delays).toEqual([2_000]);
  });

  it("falls back to Whisper Large V3 after Turbo exhausts transient retries", async () => {
    const { transcribeAudioSegments } = await import("./transcribe.js");
    const directory = await mkdtemp(join(tmpdir(), "cauli-transcription-"));
    temporaryDirectories.push(directory);
    const audioPath = join(directory, "segment.mp3");
    await writeFile(audioPath, Buffer.from("audio fixture"));

    const attemptedModels: string[] = [];
    const openRouterFetch: typeof fetch = async (_input, init) => {
      const model = JSON.parse(String(init?.body)).model as string;
      attemptedModels.push(model);
      if (model === "openai/whisper-large-v3-turbo") {
        return new Response("Unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          text: "Fallback transcript",
          usage: { seconds: 9, cost: 0.0003 },
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    const result = await transcribeAudioSegments([audioPath], {
      apiKey: "test-key",
      fallbackModel: "openai/whisper-large-v3",
      fetch: openRouterFetch,
      language: "en",
      maxAttempts: 2,
      primaryModel: "openai/whisper-large-v3-turbo",
      sleep: async () => {},
    });

    expect(result.text).toBe("Fallback transcript");
    expect(result.models).toEqual(["openai/whisper-large-v3"]);
    expect(attemptedModels).toEqual([
      "openai/whisper-large-v3-turbo",
      "openai/whisper-large-v3-turbo",
      "openai/whisper-large-v3",
    ]);
  });

  it("retries network failures with exponential backoff and jitter", async () => {
    const { transcribeAudioSegments } = await import("./transcribe.js");
    const directory = await mkdtemp(join(tmpdir(), "cauli-transcription-"));
    temporaryDirectories.push(directory);
    const audioPath = join(directory, "segment.mp3");
    await writeFile(audioPath, Buffer.from("audio fixture"));

    let attempts = 0;
    const delays: number[] = [];
    const openRouterFetch: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("network offline");
      return new Response(
        JSON.stringify({
          text: "Recovered after network failure",
          usage: { seconds: 7, cost: 0.0001 },
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    const result = await transcribeAudioSegments([audioPath], {
      apiKey: "test-key",
      fetch: openRouterFetch,
      language: "en",
      maxAttempts: 5,
      primaryModel: "openai/whisper-large-v3-turbo",
      random: () => 0.25,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(result.text).toBe("Recovered after network failure");
    expect(delays).toEqual([750]);
  });

  it("merges overlapping chunks in source order without duplicated words", async () => {
    const { transcribeAudioSegments } = await import("./transcribe.js");
    const directory = await mkdtemp(join(tmpdir(), "cauli-transcription-"));
    temporaryDirectories.push(directory);
    const firstPath = join(directory, "segment-0.mp3");
    const secondPath = join(directory, "segment-1.mp3");
    await writeFile(firstPath, Buffer.from("first"));
    await writeFile(secondPath, Buffer.from("second"));

    const openRouterFetch: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      const fixtureName = Buffer.from(
        request.input_audio.data,
        "base64"
      ).toString();
      const text =
        fixtureName === "first"
          ? "We need to call Sarah tomorrow morning"
          : "tomorrow morning before the meeting";
      return new Response(
        JSON.stringify({
          text,
          usage: { seconds: 600, cost: 0.001 },
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    const result = await transcribeAudioSegments([firstPath, secondPath], {
      apiKey: "test-key",
      fetch: openRouterFetch,
      language: "en",
      primaryModel: "openai/whisper-large-v3-turbo",
    });

    expect(result.text).toBe(
      "We need to call Sarah tomorrow morning before the meeting"
    );
  });

  it("resumes from completed chunk checkpoints after a worker restart", async () => {
    const { transcribeAudioSegments } = await import("./transcribe.js");
    const directory = await mkdtemp(join(tmpdir(), "cauli-transcription-"));
    temporaryDirectories.push(directory);
    const firstPath = join(directory, "segment-0.mp3");
    const secondPath = join(directory, "segment-1.mp3");
    await writeFile(firstPath, Buffer.from("already completed"));
    await writeFile(secondPath, Buffer.from("unfinished"));

    const checkpoints = new Map<
      number,
      {
        index: number;
        text: string;
        segments: Array<{
          sequence: number;
          startMs: number;
          endMs: number;
          text: string;
        }>;
        language: string | null;
        durationSeconds: number;
        costUsd: number;
        generationId: string | null;
        model: string;
      }
    >([
      [
        0,
        {
          index: 0,
          text: "First half",
          segments: [
            {
              sequence: 0,
              startMs: 0,
              endMs: 600_000,
              text: "First half",
            },
          ],
          language: "en",
          durationSeconds: 600,
          costUsd: 0.001,
          generationId: "generation-0",
          model: "openai/whisper-large-v3-turbo",
        },
      ],
    ]);
    const fetchedFixtures: string[] = [];
    const openRouterFetch: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      fetchedFixtures.push(
        Buffer.from(request.input_audio.data, "base64").toString()
      );
      return new Response(
        JSON.stringify({
          text: "Second half",
          usage: { seconds: 600, cost: 0.001 },
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "X-Generation-Id": "generation-1",
          },
        }
      );
    };

    const result = await transcribeAudioSegments([firstPath, secondPath], {
      apiKey: "test-key",
      checkpointStore: {
        load: async (index) => checkpoints.get(index) ?? null,
        save: async (chunk) => {
          checkpoints.set(chunk.index, chunk);
        },
      },
      fetch: openRouterFetch,
      language: "en",
      primaryModel: "openai/whisper-large-v3-turbo",
    });

    expect(fetchedFixtures).toEqual(["unfinished"]);
    expect(checkpoints.get(1)?.text).toBe("Second half");
    expect(result.text).toBe("First half Second half");
  });
});
