import {
  mergeTranscriptChunks,
  offsetTranscriptSegments,
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
  models: string[];
}

export interface TranscribedChunk {
  index: number;
  text: string;
  segments: TranscriptSegment[];
  language: string | null;
  durationSeconds: number;
  costUsd: number;
  generationId: string | null;
  model: string;
}

export interface TranscriptionCheckpointStore {
  load(index: number): Promise<TranscribedChunk | null>;
  save(chunk: TranscribedChunk): Promise<void>;
}

export interface TranscriptionOptions {
  apiKey?: string;
  checkpointStore?: TranscriptionCheckpointStore;
  fallbackModel?: string;
  fetch?: typeof fetch;
  language?: string;
  maxAttempts?: number;
  primaryModel?: string;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type TranscriptionFailureCategory =
  | "authentication"
  | "billing"
  | "invalid_request"
  | "malformed_response"
  | "network"
  | "rate_limit"
  | "timeout"
  | "provider_unavailable";

export interface ClassifiedTranscriptionFailure {
  category: TranscriptionFailureCategory;
  retryable: boolean;
}

export function classifyOpenRouterFailure(
  status: number,
  _providerMessage: string
): ClassifiedTranscriptionFailure {
  if (status === 401 || status === 403) {
    return { category: "authentication", retryable: false };
  }
  if (status === 402) {
    return { category: "billing", retryable: false };
  }
  if (status === 408 || status === 429) {
    return { category: "rate_limit", retryable: true };
  }
  if (status >= 500) {
    return { category: "provider_unavailable", retryable: true };
  }
  return { category: "invalid_request", retryable: false };
}

export class OpenRouterTranscriptionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly category: TranscriptionFailureCategory = "provider_unavailable",
    readonly chunkIndex: number | null = null,
    readonly generationId: string | null = null
  ) {
    super(message);
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>
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
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

async function transcribeSegment(
  path: string,
  index: number,
  options: Required<TranscriptionOptions>
) {
  const audio = await readFile(path);
  async function transcribeWithModel(model: string) {
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await options.fetch(
          "https://openrouter.ai/api/v1/audio/transcriptions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://cauli.pro",
              "X-OpenRouter-Title": "cauli",
            },
            body: JSON.stringify({
              input_audio: {
                data: audio.toString("base64"),
                format: "mp3",
              },
              language: options.language,
              model,
              provider: {
                data_collection: "deny",
                zdr: true,
              },
            }),
            signal: AbortSignal.timeout(60_000),
          }
        );
      } catch (error) {
        if (attempt === options.maxAttempts) {
          const timeout =
            error instanceof Error &&
            (error.name === "TimeoutError" || error.name === "AbortError");
          throw new OpenRouterTranscriptionError(
            `OpenRouter transcription network failure: ${
              error instanceof Error ? error.message : String(error)
            }`,
            true,
            timeout ? "timeout" : "network",
            index
          );
        }
        await options.sleep(
          Math.round(1_000 * 2 ** (attempt - 1) * (0.5 + options.random()))
        );
        continue;
      }

      if (response.ok) {
        const generationId = response.headers.get("x-generation-id");
        let body: OpenRouterResponse;
        try {
          body = (await response.json()) as OpenRouterResponse;
        } catch {
          throw new OpenRouterTranscriptionError(
            "OpenRouter returned invalid transcription JSON",
            false,
            "malformed_response",
            index,
            generationId
          );
        }
        const text =
          body.text ??
          body.segments?.map((segment) => segment.text).join(" ") ??
          "";
        if (!text.trim()) {
          throw new OpenRouterTranscriptionError(
            "OpenRouter returned an empty transcription",
            false,
            "malformed_response",
            index,
            generationId
          );
        }
        return {
          body: { ...body, text },
          generationId,
          model,
        };
      }

      const body = await response.text().catch(() => "");
      const failure = classifyOpenRouterFailure(response.status, body);
      if (!failure.retryable || attempt === options.maxAttempts) {
        throw new OpenRouterTranscriptionError(
          `OpenRouter transcription failed (${response.status}): ${body.slice(0, 300)}`,
          failure.retryable,
          failure.category,
          index,
          response.headers.get("x-generation-id")
        );
      }
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const delayMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1_000
          : Math.round(1_000 * 2 ** (attempt - 1) * (0.5 + options.random()));
      await options.sleep(delayMs);
    }
    throw new OpenRouterTranscriptionError(
      "OpenRouter transcription exhausted retries",
      true,
      "provider_unavailable",
      index
    );
  }

  try {
    return await transcribeWithModel(options.primaryModel);
  } catch (error) {
    if (
      !(error instanceof OpenRouterTranscriptionError) ||
      !error.retryable ||
      options.fallbackModel === options.primaryModel
    ) {
      throw error;
    }
    return transcribeWithModel(options.fallbackModel);
  }
}

export async function transcribeAudioSegments(
  paths: string[],
  overrides: TranscriptionOptions = {}
): Promise<TranscriptionResult> {
  const options: Required<TranscriptionOptions> = {
    apiKey: overrides.apiKey ?? config.openRouterKey,
    checkpointStore: overrides.checkpointStore ?? {
      load: async () => null,
      save: async () => {},
    },
    fallbackModel: overrides.fallbackModel ?? "openai/whisper-large-v3",
    fetch: overrides.fetch ?? fetch,
    language: overrides.language ?? (config.transcriptionLanguage || "en"),
    maxAttempts: overrides.maxAttempts ?? 5,
    primaryModel: overrides.primaryModel ?? config.transcriptionModel,
    random: overrides.random ?? Math.random,
    sleep:
      overrides.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
  const chunks = await mapConcurrent(paths, 3, async (path, index) => {
    const checkpoint = await options.checkpointStore.load(index);
    if (checkpoint) return checkpoint;

    const result = await transcribeSegment(path, index, options);
    const response = result.body;
    const durationSeconds = response.duration ?? response.usage?.seconds ?? 0;
    const providerSegments = response.segments?.length
      ? response.segments
      : [
          {
            start: 0,
            end: durationSeconds,
            text: response.text ?? "",
          },
        ];
    const chunk: TranscribedChunk = {
      index,
      text:
        response.text ??
        providerSegments.map((segment) => segment.text).join(" "),
      segments: offsetTranscriptSegments(providerSegments, index * 598_000),
      language: response.language ?? null,
      durationSeconds,
      costUsd: response.usage?.cost ?? 0,
      generationId: result.generationId,
      model: result.model,
    };
    await options.checkpointStore.save(chunk);
    return chunk;
  });
  const allSegments: TranscriptSegment[] = [];
  let durationSeconds = 0;
  let costUsd = 0;
  let language: string | null = null;

  for (const chunk of chunks) {
    for (const segment of chunk.segments) {
      allSegments.push({
        ...segment,
        sequence: allSegments.length,
      });
    }
    durationSeconds = Math.max(
      durationSeconds,
      chunk.index * 598 + chunk.durationSeconds
    );
    costUsd += chunk.costUsd;
    language ??= chunk.language;
  }

  return {
    segments: allSegments,
    text: mergeTranscriptChunks(chunks.map((chunk) => chunk.text)),
    language,
    durationSeconds,
    costUsd,
    generationIds: chunks.flatMap((chunk) =>
      chunk.generationId ? [chunk.generationId] : []
    ),
    models: chunks.map((chunk) => chunk.model),
  };
}
