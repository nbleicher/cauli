import { PILOT_WORKER_CONCURRENCY } from "./capacity.js";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export const config = {
  supabaseUrl:
    process.env.SUPABASE_URL?.trim() || required("NEXT_PUBLIC_SUPABASE_URL"),
  workerKey: required("SUPABASE_WORKER_KEY"),
  openRouterKey: required("OPENROUTER_API_KEY"),
  transcriptionModel:
    process.env.OPENROUTER_STT_MODEL?.trim() || "openai/whisper-large-v3-turbo",
  // The worker can fall back mid-job, so this model has to be priced too.
  transcriptionFallbackModel:
    process.env.OPENROUTER_STT_FALLBACK_MODEL?.trim() ||
    "openai/whisper-large-v3",
  transcriptionLanguage: process.env.TRANSCRIPTION_LANGUAGE?.trim() || "",
  ffmpegPath: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH?.trim() || "ffprobe",
  pollMs: positiveInteger("WORKER_POLL_MS", 2_000),
  budgetResumeMs: positiveInteger("WORKER_BUDGET_RESUME_MS", 60_000),
  // Sized from the recorded five-Call burst, not chosen. See capacity.ts.
  concurrency: positiveInteger("WORKER_CONCURRENCY", PILOT_WORKER_CONCURRENCY),
  port: positiveInteger("PORT", 8_080),
  workerName:
    process.env.RAILWAY_REPLICA_ID ||
    `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
};
