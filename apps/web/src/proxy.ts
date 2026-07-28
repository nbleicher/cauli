import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseConfigured, publicEnv, requireSupabaseEnv } from "@/lib/env";
import { securityHeaders } from "@/lib/server/security-headers";
import {
  isPlatformAdminHost,
  isPlatformAdminPath,
  platformHostAllowsPath,
} from "@/lib/server/platform-host";

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

  // Host is the browser-addressed origin. Do not let a caller forge the
  // Cloudflare-protected admin origin through X-Forwarded-Host.
  const forwardedHost =
    request.headers.get("host") ??
    request.headers.get("x-forwarded-host") ??
    "";
  const onPlatformHost = isPlatformAdminHost(
    forwardedHost,
    publicEnv.platformAdminHost,
    process.env.NODE_ENV === "development"
  );
  const dedicatedPlatformHost =
    Boolean(publicEnv.platformAdminHost) && onPlatformHost;
  const platformPath =
    isPlatformAdminPath(request.nextUrl.pathname) ||
    (request.nextUrl.pathname === "/auth/mfa" &&
      request.nextUrl.searchParams.get("platform") === "1");
  if (
    (platformPath && !onPlatformHost) ||
    (dedicatedPlatformHost && !platformHostAllowsPath(request.nextUrl.pathname))
  ) {
    const denied = new NextResponse("Not found", { status: 404 });
    for (const [name, value] of Object.entries(browserHeaders)) {
      denied.headers.set(name, value);
    }
    return denied;
  }
  if (dedicatedPlatformHost && request.nextUrl.pathname === "/") {
    const destination = request.nextUrl.clone();
    destination.pathname = "/platform-admin";
    return NextResponse.redirect(destination);
  }

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
