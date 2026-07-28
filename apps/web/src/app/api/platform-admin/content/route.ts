import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isPlatformAdminAuthError,
  requirePlatformAdminApiAuth,
} from "@/lib/server/platform-auth";
import { sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const auth = await requirePlatformAdminApiAuth();
  if (isPlatformAdminAuthError(auth)) return auth;
  const callId = z
    .uuid()
    .safeParse(new URL(request.url).searchParams.get("callId"));
  if (!callId.success) {
    return NextResponse.json({ error: "Call id is required" }, { status: 400 });
  }
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("platform_read_call_content", {
    target_call_id: callId.data,
  });
  if (error) {
    const status = /No active break-glass grant/i.test(error.message)
      ? 403
      : 400;
    return NextResponse.json({ error: sanitizeError(error) }, { status });
  }
  return NextResponse.json(data);
}
