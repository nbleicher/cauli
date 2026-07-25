import { prepareExtensionImportSchema } from "@calllog/shared";
import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { audioExtension, sha256 } from "@/lib/server/crypto";
import { parseJson, sanitizeError } from "@/lib/server/http";

export async function POST(request: Request) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;
  const parsed = await parseJson(request, prepareExtensionImportSchema);
  if (parsed.error) return parsed.error;

  const admin = createAdminSupabaseClient();
  const nonceHash = await sha256(parsed.data.nonce);
  const prepared = [];

  try {
    for (const recording of parsed.data.recordings) {
      const { data: existing } = await admin
        .from("extension_imports")
        .select("id, call_id, status, source_path, converted_path")
        .eq("workspace_id", auth.member.workspaceId)
        .eq("user_id", auth.user.id)
        .eq("legacy_recording_id", recording.legacyRecordingId)
        .maybeSingle();

      if (existing?.status === "complete") {
        prepared.push({
          importId: existing.id,
          legacyRecordingId: recording.legacyRecordingId,
          status: "complete",
          sourceUpload: null,
          convertedUpload: null,
        });
        continue;
      }

      const callId = existing?.call_id ?? crypto.randomUUID();
      const sourcePath = recording.hasSource
        ? `${auth.member.workspaceId}/${callId}/imports/source.${audioExtension(recording.sourceMimeType)}`
        : null;
      const convertedPath = recording.hasConverted
        ? `${auth.member.workspaceId}/${callId}/imports/converted.${audioExtension(recording.convertedMimeType)}`
        : null;

      if (!existing) {
        const { error: callError } = await admin.from("calls").insert({
          id: callId,
          workspace_id: auth.member.workspaceId,
          owner_id: auth.user.id,
          source_mode: recording.source,
          status: "uploading",
          review_status: "unreviewed",
          started_at: recording.date,
          stopped_at: recording.date,
          duration_ms: Math.round(recording.duration * 1_000),
          mime_type: recording.sourceMimeType || recording.convertedMimeType || "audio/webm",
          chunk_prefix: `${auth.member.workspaceId}/${callId}/chunks`,
        });
        if (callError) throw callError;
      }

      const { data: importRow, error: importError } = await admin
        .from("extension_imports")
        .upsert({
          id: existing?.id,
          workspace_id: auth.member.workspaceId,
          user_id: auth.user.id,
          legacy_recording_id: recording.legacyRecordingId,
          call_id: callId,
          status: "prepared",
          nonce_hash: nonceHash,
          source_path: sourcePath,
          converted_path: convertedPath,
          metadata: recording,
          error_message: null,
        }, { onConflict: "workspace_id,user_id,legacy_recording_id" })
        .select("id")
        .single();
      if (importError) throw importError;

      const sourceSigned = sourcePath
        ? await admin.storage.from("recordings").createSignedUploadUrl(sourcePath, { upsert: true })
        : null;
      const convertedSigned = convertedPath
        ? await admin.storage.from("recordings").createSignedUploadUrl(convertedPath, { upsert: true })
        : null;
      if (sourceSigned?.error) throw sourceSigned.error;
      if (convertedSigned?.error) throw convertedSigned.error;

      prepared.push({
        importId: importRow.id,
        legacyRecordingId: recording.legacyRecordingId,
        status: "prepared",
        sourceUpload: sourceSigned?.data ? {
          signedUrl: sourceSigned.data.signedUrl,
          contentType: recording.sourceMimeType || "audio/webm",
        } : null,
        convertedUpload: convertedSigned?.data ? {
          signedUrl: convertedSigned.data.signedUrl,
          contentType: recording.convertedMimeType || "audio/mpeg",
        } : null,
      });
    }
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }

  return NextResponse.json({ nonce: parsed.data.nonce, items: prepared });
}
