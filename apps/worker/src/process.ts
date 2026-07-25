import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { config } from "./config.js";

export interface TranscriptionChunkPlanItem {
  index: number;
  startSeconds: number;
  durationSeconds: number;
}

const TRANSCRIPTION_CHUNK_SECONDS = 600;
const TRANSCRIPTION_CHUNK_OVERLAP_SECONDS = 2;

export function buildTranscriptionChunkPlan(
  sourceDurationSeconds: number
): TranscriptionChunkPlanItem[] {
  if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
    return [];
  }
  const plan: TranscriptionChunkPlanItem[] = [];
  const step =
    TRANSCRIPTION_CHUNK_SECONDS - TRANSCRIPTION_CHUNK_OVERLAP_SECONDS;
  for (
    let startSeconds = 0, index = 0;
    startSeconds < sourceDurationSeconds;
    startSeconds += step, index += 1
  ) {
    plan.push({
      index,
      startSeconds,
      durationSeconds: Math.min(
        TRANSCRIPTION_CHUNK_SECONDS,
        sourceDurationSeconds - startSeconds
      ),
    });
    if (startSeconds + TRANSCRIPTION_CHUNK_SECONDS >= sourceDurationSeconds) {
      break;
    }
  }
  return plan;
}

export async function runProcess(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${basename(command)} exited ${code}: ${stderr.slice(-2_000)}`
          )
        );
    });
  });
}

export async function runProcessOutput(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-8_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(
            `${basename(command)} exited ${code}: ${stderr.slice(-2_000)}`
          )
        );
    });
  });
}

export function runFfmpeg(args: string[]) {
  return runProcess(config.ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...args,
  ]);
}

export async function probeAudioDuration(path: string) {
  const output = await runProcessOutput(config.ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  const duration = Number(output);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("FFprobe returned an invalid audio duration");
  }
  return duration;
}

export async function splitAudioForTranscription(
  sourcePath: string,
  directory: string
) {
  const plan = buildTranscriptionChunkPlan(
    await probeAudioDuration(sourcePath)
  );
  const paths: string[] = [];
  for (const chunk of plan) {
    const path = join(
      directory,
      `segment-${String(chunk.index).padStart(5, "0")}.mp3`
    );
    await runFfmpeg([
      "-ss",
      String(chunk.startSeconds),
      "-i",
      sourcePath,
      "-t",
      String(chunk.durationSeconds),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "32k",
      path,
    ]);
    paths.push(path);
  }
  return paths;
}

export async function ensureDirectory(path: string) {
  await mkdir(path, { recursive: true });
}

export async function writeResponseBody(response: Response, path: string) {
  if (!response.body) throw new Error("Storage download returned no body");
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(path)
  );
}

export async function concatenateFiles(paths: string[], outputPath: string) {
  const output = createWriteStream(outputPath);
  try {
    for (const path of paths) {
      await pipeline(createReadStream(path), output, { end: false });
    }
    await new Promise<void>((resolve, reject) => {
      output.once("error", reject);
      output.end(resolve);
    });
  } catch (error) {
    output.destroy();
    throw error;
  }
}

export async function listMatchingFiles(directory: string, pattern: RegExp) {
  const names = await readdir(directory);
  return names
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => join(directory, name));
}

export async function fileExists(path: string) {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

export async function fileSize(path: string) {
  return (await stat(path)).size;
}

export async function removeDirectory(path: string) {
  await rm(path, { recursive: true, force: true });
}
