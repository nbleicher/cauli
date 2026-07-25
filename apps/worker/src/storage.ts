import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { ensureDirectory } from "./process.js";
import { supabase } from "./supabase.js";

const BUCKET = "recordings";

export async function listStorageFiles(prefix: string) {
  const files: { name: string; path: string }[] = [];
  let offset = 0;
  const pageSize = 1_000;
  while (true) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;
    const page = (data ?? [])
      .filter((item) => item.id)
      .map((item) => ({ name: item.name, path: `${prefix}/${item.name}` }));
    files.push(...page);
    if ((data ?? []).length < pageSize) break;
    offset += pageSize;
  }
  return files;
}

export async function downloadStorageFile(storagePath: string, localPath: string) {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error) throw error;
  await ensureDirectory(dirname(localPath));
  await pipeline(
    Readable.fromWeb(data.stream() as never),
    createWriteStream(localPath),
  );
}

export async function uploadStorageFile(
  localPath: string,
  storagePath: string,
  contentType: string,
) {
  const data = await readFile(localPath);
  const { error } = await supabase.storage.from(BUCKET).upload(storagePath, data, {
    contentType,
    upsert: true,
  });
  if (error) throw error;
}

export async function removeStorageFiles(paths: string[]) {
  for (let index = 0; index < paths.length; index += 100) {
    const { error } = await supabase.storage.from(BUCKET).remove(paths.slice(index, index + 100));
    if (error) throw error;
  }
}

export async function downloadChunkSequence(
  prefix: string,
  expectedFinalSequence: number,
  directory: string,
) {
  const files = await listStorageFiles(prefix);
  const bySequence = new Map<number, string>();
  for (const file of files) {
    const match = file.name.match(/^(\d{8})\.webm$/);
    if (match) bySequence.set(Number(match[1]), file.path);
  }

  const missing: number[] = [];
  for (let sequence = 0; sequence <= expectedFinalSequence; sequence += 1) {
    if (!bySequence.has(sequence)) missing.push(sequence);
  }
  if (missing.length) {
    throw new Error(`Recording is missing ${missing.length} chunk(s); first missing sequence ${missing[0]}`);
  }

  const paths: string[] = [];
  for (let sequence = 0; sequence <= expectedFinalSequence; sequence += 1) {
    const localPath = join(directory, `${sequence.toString().padStart(8, "0")}.webm`);
    await downloadStorageFile(bySequence.get(sequence)!, localPath);
    paths.push(localPath);
  }
  return {
    localPaths: paths,
    storagePaths: Array.from(bySequence.values()),
  };
}
