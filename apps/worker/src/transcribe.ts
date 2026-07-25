import {
  offsetTranscriptSegments,
  transcriptText,
  type TranscriptSegment,
} from "@calllog/shared";
import { readFile } from "node:fs/promises";
import { config } from "./config.js";

interface OpenRouterResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string }>;
  usage?: {
    seconds?: number;
    cost?: number;
  };
}

export interface TranscriptionResult {
  segments: TranscriptSegment[];
  text: string;
  language: string | null;
  durationSeconds: number;
  costUsd: number;
  generationIds: string[];
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await operation(items[index]!, index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

async function transcribeSegment(path: string, index: number) {
  const form = new FormData();
  form.append("file", new Blob([await readFile(path)], { type: "audio/mpeg" }), `segment-${index}.mp3`);
  form.append("model", config.transcriptionModel);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  if (config.transcriptionLanguage) form.append("language", config.transcriptionLanguage);

  const response = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterKey}`,
      "HTTP-Referer": "https://cauli.pro",
      "X-Title": "cauli",
    },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenRouter transcription failed (${response.status}): ${body.slice(0, 300)}`);
  }

  return {
    body: await response.json() as OpenRouterResponse,
    generationId: response.headers.get("x-generation-id"),
  };
}

export async function transcribeAudioSegments(paths: string[]): Promise<TranscriptionResult> {
  const results = await mapConcurrent(paths, 3, transcribeSegment);
  const allSegments: TranscriptSegment[] = [];
  const generationIds: string[] = [];
  let durationSeconds = 0;
  let costUsd = 0;
  let language: string | null = null;

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]!;
    const response = result.body;
    const offsetMs = index * 10 * 60 * 1_000;
    const providerSegments = response.segments?.length
      ? response.segments
      : [{
        start: 0,
        end: response.duration ?? response.usage?.seconds ?? 0,
        text: response.text ?? "",
      }];
    allSegments.push(...offsetTranscriptSegments(
      providerSegments,
      offsetMs,
      allSegments.length,
    ));
    if (result.generationId) generationIds.push(result.generationId);
    durationSeconds += response.duration ?? response.usage?.seconds ?? 0;
    costUsd += response.usage?.cost ?? 0;
    language ??= response.language ?? null;
  }

  return {
    segments: allSegments,
    text: transcriptText(allSegments),
    language,
    durationSeconds,
    costUsd,
    generationIds,
  };
}
