import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseConfigured, publicEnv, requireSupabaseEnv } from "@/lib/env";
import { securityHeaders } from "@/lib/server/security-headers";

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const browserHeaders = securityHeaders({
    nonce,
    supabaseUrl: publicEnv.supabaseUrl,
    cspMode: publicEnv.cspMode,
    development: process.env.NODE_ENV === "development",
    hstsIncludeSubdomains: publicEnv.hstsIncludeSubdomains,
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  const csp = Object.entries(browserHeaders).find(([name]) =>
    name.startsWith("Content-Security-Policy")
  );
  if (csp) requestHeaders.set(csp[0], csp[1]);

  let response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  if (isSupabaseConfigured()) {
    const { url, anonKey } = requireSupabaseEnv();
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({
            request: { headers: requestHeaders },
          });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    });

    await supabase.auth.getUser();
  }
  for (const [name, value] of Object.entries(browserHeaders)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
