import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { publicEnv } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Redirects are built from the configured public origin, never from request.url:
// behind Railway's proxy the request resolves to the container's internal bind
// address, which was sending users to https://0.0.0.0:8080/login.
function redirectTo(path: string) {
  return NextResponse.redirect(new URL(path, publicEnv.appUrl));
}

// Same-site paths only, so ?next= cannot be used as an open redirect.
function safeNext(value: string | null) {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/record";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(url.searchParams.get("next"));

  // PKCE — what the browser-initiated magic link on /login produces.
  if (code) {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    return redirectTo(error ? "/login?error=auth_callback" : next);
  }

  // token_hash — email templates built on {{ .TokenHash }}.
  if (tokenHash && type) {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    return redirectTo(error ? "/login?error=auth_callback" : next);
  }

  // Nothing readable server-side. Admin invite links (inviteUserByEmail) use the
  // implicit flow and return the session in the URL fragment, which browsers never
  // send to the server. Hand off to a client page — the fragment survives this
  // redirect because the Location header carries none of its own.
  return redirectTo(`/auth/complete?next=${encodeURIComponent(next)}`);
}
