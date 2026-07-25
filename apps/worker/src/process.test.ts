import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
process.env.OPENROUTER_API_KEY = "config-key";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("concatenateFiles", () => {
  it("assembles recording chunks in source order", async () => {
    const { concatenateFiles } = await import("./process.js");
    const directory = await mkdtemp(join(tmpdir(), "cauli-concatenate-"));
    temporaryDirectories.push(directory);
    const first = join(directory, "first.webm");
    const second = join(directory, "second.webm");
    const output = join(directory, "source.webm");
    await writeFile(first, "first-");
    await writeFile(second, "second");

    await concatenateFiles([first, second], output);

    expect(await readFile(output, "utf8")).toBe("first-second");
  });
});

describe("buildTranscriptionChunkPlan", () => {
  it("plans ten-minute chunks with a two-second overlap and no empty tail", async () => {
    const { buildTranscriptionChunkPlan } = await import("./process.js");

    expect(buildTranscriptionChunkPlan(1_201)).toEqual([
      { index: 0, startSeconds: 0, durationSeconds: 600 },
      { index: 1, startSeconds: 598, durationSeconds: 600 },
      { index: 2, startSeconds: 1_196, durationSeconds: 5 },
    ]);
    expect(buildTranscriptionChunkPlan(600)).toEqual([
      { index: 0, startSeconds: 0, durationSeconds: 600 },
    ]);
  });
});
