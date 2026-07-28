import { transcriptSrt, transcriptTxt } from "@calllog/shared";
import { NextResponse } from "next/server";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { rateLimitResponse, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const SIGNED_URL_SECONDS = 600;

const FORMATS = {
  txt: { extension: "txt", contentType: "text/plain; charset=utf-8" },
  srt: { extension: "srt", contentType: "application/x-subrip" },
} as const;

/**
 * Exports a Transcript as a downloadable file.
 *
 * The file is written beside the Call's other derived artifacts and delivered
 * by short-lived signed URL, rather than streamed from this route, for two
 * reasons: it inherits exactly the storage access boundary the media downloads
 * already use, and it lands under the prefix the deletion job sweeps, so
 * retention removes generated exports without having to be taught about them.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;
  const { id } = await params;

  const requested = new URL(request.url).searchParams.get("format") ?? "txt";
  if (requested !== "txt" && requested !== "srt") {
    return NextResponse.json(
      { error: "Transcript exports are TXT or SRT" },
      { status: 400 }
    );
  }
  const format = FORMATS[requested];

  const supabase = await createServerSupabaseClient();
  // Authorization, both rate limits, and the Audit Event happen before a byte
  // is generated, so a refused export leaves no artifact behind.
  const { data: authorized, error: authorizeError } = await supabase.rpc(
    "authorize_call_download",
    {
      target_call_id: id,
      target_artifact: `transcript_${requested}`,
      target_delivery: "download",
    }
  );
  if (authorizeError) {
    const limited = await rateLimitResponse(authorizeError);
    if (limited) return limited;
    return NextResponse.json(
      { error: sanitizeError(authorizeError) },
      { status: 404 }
    );
  }
  const { workspaceId } = authorized as { workspaceId: string };

  const { data: transcript, error: transcriptError } = await supabase
    .from("transcripts")
    .select("id")
    .eq("call_id", id)
    .maybeSingle();
  if (transcriptError) {
    return NextResponse.json(
      { error: sanitizeError(transcriptError) },
      { status: 500 }
    );
  }
  if (!transcript) {
    return NextResponse.json(
      { error: "This Call has no Transcript yet" },
      { status: 404 }
    );
  }

  const { data: segments, error: segmentsError } = await supabase
    .from("transcript_segments")
    .select("sequence, start_ms, end_ms, text")
    .eq("transcript_id", transcript.id)
    .order("sequence");
  if (segmentsError) {
    return NextResponse.json(
      { error: sanitizeError(segmentsError) },
      { status: 500 }
    );
  }

  const rows = (segments ?? []).map((segment) => ({
    sequence: segment.sequence,
    startMs: Number(segment.start_ms),
    endMs: Number(segment.end_ms),
    text: segment.text,
  }));
  const body = requested === "srt" ? transcriptSrt(rows) : transcriptTxt(rows);
  if (!body) {
    return NextResponse.json(
      { error: "This Call has no Transcript yet" },
      { status: 404 }
    );
  }

  const path = `${workspaceId}/${id}/artifacts/transcript.${format.extension}`;
  const { error: uploadError } = await supabase.storage
    .from("recordings")
    .upload(path, new Blob([body], { type: format.contentType }), {
      contentType: format.contentType,
      upsert: true,
    });
  if (uploadError) {
    return NextResponse.json(
      { error: sanitizeError(uploadError) },
      { status: 500 }
    );
  }

  const { data: signed, error: signError } = await supabase.storage
    .from("recordings")
    .createSignedUrl(path, SIGNED_URL_SECONDS, { download: true });
  if (signError) {
    return NextResponse.json(
      { error: sanitizeError(signError) },
      { status: 500 }
    );
  }

  return NextResponse.json({
    url: signed.signedUrl,
    expiresIn: SIGNED_URL_SECONDS,
    format: requested,
  });
}
