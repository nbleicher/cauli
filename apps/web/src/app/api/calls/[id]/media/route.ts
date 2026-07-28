import { NextResponse } from "next/server";
import { authorizeCall } from "@/lib/server/calls";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { rateLimitResponse, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const SIGNED_URL_SECONDS = 600;
const MEDIA_FORMATS = new Set(["mp3", "source", "wav"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;
  const { id } = await params;
  const call = await authorizeCall(auth, id, "view");
  if (!call)
    return NextResponse.json({ error: "Call not found" }, { status: 404 });

  const query = new URL(request.url).searchParams;
  const format = query.get("format") ?? "mp3";
  if (!MEDIA_FORMATS.has(format)) {
    return NextResponse.json(
      { error: "Media downloads are MP3, Source Audio, or WAV" },
      { status: 400 }
    );
  }
  const path =
    format === "source"
      ? call.row.source_path
      : format === "wav"
        ? call.row.wav_path
        : call.row.mp3_path;

  if (!path) {
    return NextResponse.json(
      { error: `${format.toUpperCase()} is not ready` },
      { status: 404 }
    );
  }

  const download = query.get("download") === "1";
  const supabase = await createServerSupabaseClient();
  // One place decides whether an artifact may be handed over, spends the
  // download allowance, and writes the Audit Event, so a media download and a
  // Transcript export cannot end up accountable on different terms.
  const { error: authorizeError } = await supabase.rpc(
    "authorize_call_download",
    {
      target_call_id: id,
      target_artifact: format,
      target_delivery: download ? "download" : "playback",
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

  const { data, error } = await supabase.storage
    .from("recordings")
    .createSignedUrl(path, SIGNED_URL_SECONDS, { download });

  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  return NextResponse.json({
    url: data.signedUrl,
    expiresIn: SIGNED_URL_SECONDS,
  });
}
