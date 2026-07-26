"use client";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import {
  deleteCallDraft,
  deleteChunk,
  deleteDraft,
  listChunks,
  listDrafts,
  saveChunk,
  saveDraft,
  type RecordingDraft,
} from "@/lib/recording-db";

export function persistRecordingDraft(draft: RecordingDraft) {
  return saveDraft(draft);
}

export async function listRecoverableRecordingDrafts() {
  const drafts = await listDrafts();
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function uploadRecordingChunk(
  storagePrefix: string,
  callId: string,
  sequence: number,
  blob: Blob
) {
  const supabase = createBrowserSupabaseClient();
  const path = `${storagePrefix}/${sequence.toString().padStart(8, "0")}.webm`;
  const { error } = await supabase.storage
    .from("recordings")
    .upload(path, blob, {
      contentType: blob.type || "audio/webm",
      upsert: true,
    });
  if (error) throw error;
  await deleteChunk(callId, sequence);
}

export async function persistAndUploadRecordingChunk(
  draft: RecordingDraft,
  sequence: number,
  blob: Blob
) {
  await saveChunk(draft.callId, sequence, blob);
  await saveDraft(draft);
  await uploadRecordingChunk(draft.storagePrefix, draft.callId, sequence, blob);
}

export async function finalizeRecordingDraft(draft: RecordingDraft) {
  const chunks = await listChunks(draft.callId);
  for (const chunk of chunks) {
    await uploadRecordingChunk(
      draft.storagePrefix,
      draft.callId,
      chunk.sequence,
      chunk.blob
    );
  }

  const response = await fetch(`/api/calls/${draft.callId}/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      finalChunkSequence: draft.finalChunkSequence,
      durationMs: Math.max(1, draft.durationMs),
      mimeType: draft.mimeType,
      sourceMode: draft.sourceMode,
      micLabel: draft.micLabel,
      tabLabel: draft.tabLabel,
      degradedIntervals: draft.degradedIntervals ?? [],
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || "Unable to finalize Recording");
  }
  await deleteDraft(draft.callId);
}

export async function discardRecordingDraft(draft: RecordingDraft) {
  const response = await fetch(`/api/calls/${draft.callId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "Unable to discard Incomplete Recording");
  }
  await deleteCallDraft(draft.callId);
}
