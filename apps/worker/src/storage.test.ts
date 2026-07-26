import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://storage.example.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "streaming-service-role";
process.env.OPENROUTER_API_KEY = "config-key";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("uploadStorageFile", () => {
  it("streams an artifact to private Storage with its exact content length", async () => {
    const { uploadStorageFile } = await import("./storage.js");
    const directory = await mkdtemp(join(tmpdir(), "cauli-storage-upload-"));
    temporaryDirectories.push(directory);
    const localPath = join(directory, "recording.wav");
    await writeFile(localPath, "streamed WAV fixture");

    let uploadedBody = "";
    await uploadStorageFile(
      localPath,
      "workspace/call/artifacts/recording.wav",
      "audio/wav",
      {
        fetch: async (input, init) => {
          expect(String(input)).toBe(
            "https://storage.example.test/storage/v1/object/recordings/workspace/call/artifacts/recording.wav"
          );
          expect(new Headers(init?.headers).get("content-length")).toBe("20");
          expect(init?.body).toBeInstanceOf(ReadableStream);
          uploadedBody = await new Response(init?.body).text();
          return new Response(null, { status: 200 });
        },
      }
    );

    expect(uploadedBody).toBe("streamed WAV fixture");
  });
});
