import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { authorizeCall } from "@/lib/server/calls";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { sanitizeError } from "@/lib/server/http";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;
  const { id } = await params;
  const call = await authorizeCall(auth, id, "view");
  if (!call) return NextResponse.json({ error: "Call not found" }, { status: 404 });

  const format = new URL(request.url).searchParams.get("format") ?? "mp3";
  const path = format === "source"
    ? call.row.source_path
    : format === "wav"
      ? call.row.wav_path
      : call.row.mp3_path;

  if (!path) {
    return NextResponse.json({ error: `${format.toUpperCase()} is not ready` }, { status: 404 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.storage.from("recordings").createSignedUrl(path, 600, {
    download: new URL(request.url).searchParams.get("download") === "1",
  });

  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  return NextResponse.json({ url: data.signedUrl, expiresIn: 600 });
}
