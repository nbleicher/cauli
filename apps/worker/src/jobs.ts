import type { ProcessingJobKind } from "@calllog/shared";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { createSupabaseCheckpointStore } from "./checkpoint-store.js";
import { startJobLeaseHeartbeat } from "./job-lease.js";
import { log, sanitizedError } from "./log.js";
import {
  concatenateFiles,
  fileSize,
  removeDirectory,
  runFfmpeg,
  splitAudioForTranscription,
} from "./process.js";
import {
  downloadChunkSequence,
  downloadStorageFile,
  listStorageFiles,
  removeStorageFiles,
  uploadStorageFile,
} from "./storage.js";
import { supabase } from "./supabase.js";
import {
  OpenRouterTranscriptionError,
  transcribeAudioSegments,
  type TranscriptionResult,
} from "./transcribe.js";
import { WAV_EXPORT_FORMAT } from "./wav.js";

interface ProcessingJob {
  id: string;
  workspace_id: string;
  call_id: string | null;
  kind: ProcessingJobKind;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
  lease_token: string;
}

interface CallRow {
  id: string;
  workspace_id: string;
  expected_final_chunk: number | null;
  chunk_prefix: string;
  source_path: string | null;
  mp3_path: string | null;
  mime_type: string;
}

type StopHeartbeat = () => Promise<boolean>;

async function loadCall(callId: string) {
  const { data, error } = await supabase
    .from("calls")
    .select(
      "id, workspace_id, expected_final_chunk, chunk_prefix, source_path, mp3_path, mime_type"
    )
    .eq("id", callId)
    .single();
  if (error) throw error;
  return data as CallRow;
}

async function processRecording(
  job: ProcessingJob,
  stopHeartbeat: StopHeartbeat
) {
  if (!job.call_id) throw new Error("Recording job has no call");
  const call = await loadCall(job.call_id);

  const directory = await mkdtemp(join(tmpdir(), `calllog-${call.id}-`));
  try {
    const inputPath = join(directory, "input-audio");
    const sourcePath = join(directory, "source.webm");
    let chunkStoragePaths: string[] = [];

    if (call.source_path) {
      await downloadStorageFile(call.source_path, inputPath);
    } else {
      if (call.expected_final_chunk === null) {
        throw new Error("Final recording chunk was not declared");
      }
      const chunks = await downloadChunkSequence(
        call.chunk_prefix,
        call.expected_final_chunk,
        join(directory, "chunks")
      );
      chunkStoragePaths = chunks.storagePaths;
      await concatenateFiles(chunks.localPaths, inputPath);
    }

    if (/webm/i.test(call.mime_type)) {
      await copyFile(inputPath, sourcePath);
    } else {
      await runFfmpeg([
        "-i",
        inputPath,
        "-vn",
        "-c:a",
        "libopus",
        "-b:a",
        "128k",
        sourcePath,
      ]);
    }

    const mp3Path = join(directory, "recording.mp3");
    await runFfmpeg([
      "-i",
      sourcePath,
      "-vn",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      mp3Path,
    ]);

    const artifactPrefix = `${call.workspace_id}/${call.id}/artifacts`;
    const finalSourcePath = `${artifactPrefix}/source.webm`;
    const finalMp3Path = `${artifactPrefix}/recording.mp3`;
    await uploadStorageFile(sourcePath, finalSourcePath, "audio/webm");
    await uploadStorageFile(mp3Path, finalMp3Path, "audio/mpeg");

    let transcription: TranscriptionResult | null = null;
    if (job.payload.skipTranscription !== true) {
      const segmentPaths = await splitAudioForTranscription(
        sourcePath,
        directory
      );
      if (!segmentPaths.length)
        throw new Error("FFmpeg produced no transcription segments");

      transcription = await transcribeAudioSegments(segmentPaths, {
        checkpointStore: createSupabaseCheckpointStore(call.id),
      });
    }

    if (!(await stopHeartbeat())) {
      throw new Error("Job lease was lost before recording commit");
    }
    const { data: committed, error: commitError } = await supabase.rpc(
      "commit_processed_recording",
      {
        target_job_id: job.id,
        target_lease_token: job.lease_token,
        target_source_path: finalSourcePath,
        target_mp3_path: finalMp3Path,
        target_source_bytes: await fileSize(sourcePath),
        target_model: transcription ? config.transcriptionModel : null,
        target_language: transcription?.language ?? null,
        target_full_text: transcription?.text ?? null,
        target_provider_generation_id:
          transcription?.generationIds.join(",") ?? null,
        target_provider_cost_usd: transcription?.costUsd ?? null,
        target_provider_duration_seconds:
          transcription?.durationSeconds ?? null,
        target_segments:
          transcription?.segments.map((segment) => ({
            sequence: segment.sequence,
            start_ms: segment.startMs,
            end_ms: segment.endMs,
            text: segment.text,
          })) ?? null,
      }
    );
    if (commitError) throw commitError;
    if (!committed)
      throw new Error("Job lease was lost before recording commit");

    if (chunkStoragePaths.length) await removeStorageFiles(chunkStoragePaths);
  } finally {
    await removeDirectory(directory);
  }
}

async function generateWav(job: ProcessingJob, stopHeartbeat: StopHeartbeat) {
  if (!job.call_id) throw new Error("WAV job has no call");
  const call = await loadCall(job.call_id);
  if (!call.source_path) throw new Error("Source audio is not ready");
  const directory = await mkdtemp(join(tmpdir(), `calllog-wav-${call.id}-`));
  try {
    const sourcePath = join(directory, "source.webm");
    const wavPath = join(directory, "recording.wav");
    await downloadStorageFile(call.source_path, sourcePath);
    await runFfmpeg([
      "-i",
      sourcePath,
      "-vn",
      "-ac",
      String(WAV_EXPORT_FORMAT.channels),
      "-ar",
      String(WAV_EXPORT_FORMAT.sampleRate),
      "-c:a",
      WAV_EXPORT_FORMAT.codec,
      wavPath,
    ]);
    const storagePath = `${call.workspace_id}/${call.id}/artifacts/recording.wav`;
    await uploadStorageFile(wavPath, storagePath, "audio/wav");
    if (!(await stopHeartbeat())) {
      throw new Error("Job lease was lost before WAV export commit");
    }
    const { data: committed, error: commitError } = await supabase.rpc(
      "commit_wav_export",
      {
        target_job_id: job.id,
        target_lease_token: job.lease_token,
        target_wav_path: storagePath,
      }
    );
    if (commitError) throw commitError;
    if (!committed)
      throw new Error("Job lease was lost before WAV export commit");
  } finally {
    await removeDirectory(directory);
  }
}

async function deleteCall(job: ProcessingJob, stopHeartbeat: StopHeartbeat) {
  if (!job.call_id) throw new Error("Delete job has no call");
  const { error: startError } = await supabase.rpc(
    "start_call_deletion_execution",
    { target_call_id: job.call_id }
  );
  if (startError) throw startError;
  const prefix = `${job.workspace_id}/${job.call_id}`;
  const chunkFiles = await listStorageFiles(`${prefix}/chunks`);
  const artifactFiles = await listStorageFiles(`${prefix}/artifacts`);
  const importFiles = await listStorageFiles(`${prefix}/imports`);
  await removeStorageFiles(
    [...chunkFiles, ...artifactFiles, ...importFiles].map((file) => file.path)
  );
  if (!(await stopHeartbeat())) {
    throw new Error("Job lease was lost before Call deletion");
  }
  const { data: committed, error } = await supabase.rpc(
    "commit_call_deletion",
    {
      target_job_id: job.id,
      target_lease_token: job.lease_token,
    }
  );
  if (error) throw error;
  if (!committed) throw new Error("Job lease was lost before Call deletion");
}

async function handleJob(job: ProcessingJob, stopHeartbeat: StopHeartbeat) {
  if (job.kind === "process_recording") {
    await processRecording(job, stopHeartbeat);
    return true;
  }
  if (job.kind === "generate_wav") {
    await generateWav(job, stopHeartbeat);
    return true;
  }
  if (job.kind === "delete_call") {
    await deleteCall(job, stopHeartbeat);
    return true;
  }
  if (job.kind === "cleanup_abandoned") {
    await cleanupAbandonedCalls();
    return false;
  }
  throw new Error(`Unsupported job kind: ${job.kind}`);
}

export async function claimJob() {
  const { data, error } = await supabase.rpc("claim_processing_job", {
    worker_name: config.workerName,
  });
  if (error) throw error;
  return (data?.[0] ?? null) as ProcessingJob | null;
}

async function renewJobLease(job: ProcessingJob) {
  const { data, error } = await supabase.rpc("renew_processing_job_lease", {
    target_job_id: job.id,
    target_lease_token: job.lease_token,
  });
  if (error) throw error;
  return data === true;
}

async function updateOwnedJob(
  job: ProcessingJob,
  values: Record<string, unknown>
) {
  const { data, error } = await supabase
    .from("processing_jobs")
    .update(values)
    .eq("id", job.id)
    .eq("status", "processing")
    .eq("lease_token", job.lease_token)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

export async function runJob(job: ProcessingJob) {
  log.info("job_started", {
    jobId: job.id,
    callId: job.call_id,
    kind: job.kind,
    attempt: job.attempts,
  });
  const heartbeat = startJobLeaseHeartbeat(() => renewJobLease(job), {
    onError: (error) => {
      log.error("job_lease_heartbeat_failed", {
        jobId: job.id,
        error: sanitizedError(error),
      });
    },
  });
  try {
    const completedAtomically = await handleJob(job, () => heartbeat.stop());
    if (completedAtomically) {
      log.info("job_completed", {
        jobId: job.id,
        callId: job.call_id,
        kind: job.kind,
      });
      return;
    }
    const ownsLease = await heartbeat.stop();
    const completed =
      ownsLease &&
      (await updateOwnedJob(job, {
        status: "complete",
        finished_at: new Date().toISOString(),
        error_message: null,
        error_category: null,
        error_chunk_index: null,
        provider_generation_id: null,
        locked_at: null,
        locked_by: null,
        lease_token: null,
      }));
    if (!completed) {
      log.error("job_lease_lost", {
        jobId: job.id,
        callId: job.call_id,
        kind: job.kind,
      });
      return;
    }
    log.info("job_completed", {
      jobId: job.id,
      callId: job.call_id,
      kind: job.kind,
    });
  } catch (error) {
    const ownsLease = await heartbeat.stop();
    const message = sanitizedError(error);
    if (ownsLease && job.kind === "delete_call") {
      const { error: deletionAuditError } = await supabase.rpc(
        "fail_call_deletion_execution",
        {
          target_job_id: job.id,
          target_lease_token: job.lease_token,
        }
      );
      if (deletionAuditError) throw deletionAuditError;
    }
    const transcriptionError =
      error instanceof OpenRouterTranscriptionError ? error : null;
    const exhausted =
      job.attempts >= job.max_attempts ||
      transcriptionError?.retryable === false;
    const retryDelayMs = 30_000 * 2 ** Math.max(0, job.attempts - 1);
    const failureRecorded =
      ownsLease &&
      (await updateOwnedJob(job, {
        status: exhausted ? "failed" : "retrying",
        next_attempt_at: new Date(Date.now() + retryDelayMs).toISOString(),
        error_message: message,
        error_category: transcriptionError?.category ?? "internal",
        error_chunk_index: transcriptionError?.chunkIndex ?? null,
        provider_generation_id: transcriptionError?.generationId ?? null,
        locked_at: null,
        locked_by: null,
        lease_token: null,
        finished_at: exhausted ? new Date().toISOString() : null,
      }));
    if (!failureRecorded) {
      log.error("job_lease_lost", {
        jobId: job.id,
        callId: job.call_id,
        kind: job.kind,
        error: message,
      });
      return;
    }
    if (job.call_id && exhausted && job.kind === "process_recording") {
      await supabase
        .from("calls")
        .update({
          status: "failed",
          error_message: transcriptionError
            ? "Transcription could not be completed. Your recording is safe and can be retried."
            : "Processing could not be completed. Your recording is safe and can be retried.",
        })
        .eq("id", job.call_id);
    }
    if (exhausted && job.kind === "generate_wav") {
      const exportJobId = job.payload.exportJobId;
      if (typeof exportJobId === "string") {
        await supabase
          .from("export_jobs")
          .update({
            status: "failed",
            error_message: "WAV export could not be completed. Please retry.",
          })
          .eq("id", exportJobId);
      }
    }
    log.error("job_failed", {
      jobId: job.id,
      callId: job.call_id,
      kind: job.kind,
      exhausted,
      errorCategory: transcriptionError?.category ?? "internal",
      chunkIndex: transcriptionError?.chunkIndex ?? null,
      generationId: transcriptionError?.generationId ?? null,
      error: message,
    });
  }
}

export async function cleanupAbandonedCalls() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString();
  const { data: calls, error } = await supabase
    .from("calls")
    .select("id, workspace_id, chunk_prefix")
    .in("status", ["recording", "uploading"])
    .lt("updated_at", cutoff)
    .is("deleted_at", null);
  if (error) throw error;

  for (const call of calls ?? []) {
    await supabase
      .from("calls")
      .update({
        status: "abandoned",
        error_message:
          "Recording upload was not finalized within seven days. Source Audio is retained for recovery.",
      })
      .eq("id", call.id);
  }
  log.info("abandoned_cleanup_complete", { count: calls?.length ?? 0 });
}
