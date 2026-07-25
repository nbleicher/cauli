import type {
  TranscribedChunk,
  TranscriptionCheckpointStore,
} from "./transcribe.js";
import { supabase } from "./supabase.js";

interface TranscriptionChunkRow {
  chunk_index: number;
  text: string;
  segments: TranscribedChunk["segments"];
  language: string | null;
  duration_seconds: number | string;
  cost_usd: number | string;
  provider_generation_id: string | null;
  model: string;
}

function fromRow(row: TranscriptionChunkRow): TranscribedChunk {
  return {
    index: row.chunk_index,
    text: row.text,
    segments: row.segments,
    language: row.language,
    durationSeconds: Number(row.duration_seconds),
    costUsd: Number(row.cost_usd),
    generationId: row.provider_generation_id,
    model: row.model,
  };
}

export function createSupabaseCheckpointStore(
  callId: string
): TranscriptionCheckpointStore {
  return {
    async load(index) {
      const { data, error } = await supabase
        .from("transcription_chunks")
        .select(
          "chunk_index, text, segments, language, duration_seconds, cost_usd, provider_generation_id, model"
        )
        .eq("call_id", callId)
        .eq("chunk_index", index)
        .maybeSingle();
      if (error) throw error;
      return data ? fromRow(data as TranscriptionChunkRow) : null;
    },
    async save(chunk) {
      const { error } = await supabase.from("transcription_chunks").upsert(
        {
          call_id: callId,
          chunk_index: chunk.index,
          text: chunk.text,
          segments: chunk.segments,
          language: chunk.language,
          duration_seconds: chunk.durationSeconds,
          cost_usd: chunk.costUsd,
          provider_generation_id: chunk.generationId,
          model: chunk.model,
          completed_at: new Date().toISOString(),
        },
        {
          onConflict: "call_id,chunk_index",
        }
      );
      if (error) throw error;
    },
  };
}
