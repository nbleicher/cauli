import { completeExtensionImportSchema } from "@calllog/shared";
import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { sha256 } from "@/lib/server/crypto";
import { parseJson, sanitizeError } from "@/lib/server/http";

interface ImportMetadata {
  date: string;
  duration: number;
  source: "mic" | "tab" | "both";
  transcript: string;
  transcriptStatus: string;
  sourceMimeType: string;
  convertedMimeType: string;
  hasSource: boolean;
  hasConverted: boolean;
}

export async function POST(request: Request) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;
  const parsed = await parseJson(request, completeExtensionImportSchema);
  if (parsed.error) return parsed.error;

  const admin = createAdminSupabaseClient();
  const nonceHash = await sha256(parsed.data.nonce);
  const completed: string[] = [];

  try {
    for (const item of parsed.data.items) {
      const { data: importRow, error: importError } = await admin
        .from("extension_imports")
        .select("id, call_id, status, nonce_hash, source_path, converted_path, metadata")
        .eq("id", item.importId)
        .eq("workspace_id", auth.member.workspaceId)
        .eq("user_id", auth.user.id)
        .single();
      if (importError) throw importError;
      if (importRow.status === "complete") {
        completed.push(importRow.id);
        continue;
      }
      if (importRow.nonce_hash !== nonceHash) throw new Error("Import nonce did not match");

      const metadata = importRow.metadata as ImportMetadata;
      const sourceReady = Boolean(importRow.source_path && item.sourceUploaded);
      const convertedReady = Boolean(importRow.converted_path && item.convertedUploaded);
      const usableSourcePath = sourceReady
        ? importRow.source_path
        : convertedReady
          ? importRow.converted_path
          : null;
      if (!usableSourcePath) {
        await admin.from("extension_imports").update({
          status: "failed",
          error_message: "No legacy audio was uploaded.",
        }).eq("id", importRow.id);
        await admin.from("calls").update({
          status: "failed",
          error_message: "No legacy audio was uploaded.",
        }).eq("id", importRow.call_id);
        continue;
      }

      const hasCompletedTranscript = metadata.transcriptStatus === "done"
        && Boolean(metadata.transcript.trim());
      if (hasCompletedTranscript) {
        await admin.from("transcripts").upsert({
          call_id: importRow.call_id,
          model: "legacy-extension",
          full_text: metadata.transcript.trim(),
        }, { onConflict: "call_id" });
      }

      const convertedIsMp3 = convertedReady
        && /mpeg|mp3/i.test(metadata.convertedMimeType);
      const { error: callError } = await admin.from("calls").update({
        status: "queued",
        source_path: usableSourcePath,
        mp3_path: convertedIsMp3 ? importRow.converted_path : null,
        mime_type: sourceReady
          ? metadata.sourceMimeType || "audio/webm"
          : metadata.convertedMimeType || "audio/mpeg",
        error_message: null,
      }).eq("id", importRow.call_id);
      if (callError) throw callError;

      const { error: jobError } = await admin.from("processing_jobs").upsert({
        workspace_id: auth.member.workspaceId,
        call_id: importRow.call_id,
        kind: "process_recording",
        status: "queued",
        idempotency_key: `process:${importRow.call_id}`,
        payload: { skipTranscription: hasCompletedTranscript, extensionImportId: importRow.id },
      }, { onConflict: "idempotency_key" });
      if (jobError) throw jobError;

      await admin.from("extension_imports").update({
        status: "queued",
        error_message: null,
      }).eq("id", importRow.id);
      completed.push(importRow.id);
    }
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }

  return NextResponse.json({ completed });
}
