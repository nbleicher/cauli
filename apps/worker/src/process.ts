import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { config } from "./config.js";

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
      else reject(new Error(`${basename(command)} exited ${code}: ${stderr.slice(-2_000)}`));
    });
  });
}

export function runFfmpeg(args: string[]) {
  return runProcess(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

export async function ensureDirectory(path: string) {
  await mkdir(path, { recursive: true });
}

export async function writeResponseBody(response: Response, path: string) {
  if (!response.body) throw new Error("Storage download returned no body");
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(path),
  );
}

export async function concatenateFiles(paths: string[], outputPath: string) {
  const chunks: Buffer[] = [];
  for (const path of paths) chunks.push(await readFile(path));
  await writeFile(outputPath, Buffer.concat(chunks));
}

export async function listMatchingFiles(directory: string, pattern: RegExp) {
  const names = await readdir(directory);
  return names.filter((name) => pattern.test(name)).sort().map((name) => join(directory, name));
}

export async function fileExists(path: string) {
  return access(path).then(() => true).catch(() => false);
}

export async function fileSize(path: string) {
  return (await stat(path)).size;
}

export async function removeDirectory(path: string) {
  await rm(path, { recursive: true, force: true });
}
