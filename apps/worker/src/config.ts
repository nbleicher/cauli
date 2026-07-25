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
  supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL"),
  serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  openRouterKey: required("OPENROUTER_API_KEY"),
  transcriptionModel: process.env.OPENROUTER_STT_MODEL?.trim()
    || "openai/whisper-large-v3-turbo",
  transcriptionLanguage: process.env.TRANSCRIPTION_LANGUAGE?.trim() || "",
  ffmpegPath: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
  pollMs: positiveInteger("WORKER_POLL_MS", 2_000),
  concurrency: positiveInteger("WORKER_CONCURRENCY", 1),
  port: positiveInteger("PORT", 8_080),
  workerName: process.env.RAILWAY_REPLICA_ID
    || `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
};
