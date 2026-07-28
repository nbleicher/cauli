import { NextResponse } from "next/server";
import { publicEnv } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  const requestUrl = new URL(request.url);
  if (requestUrl.searchParams.get("boundary") === "platform") {
    const appProtocol = new URL(publicEnv.appUrl).protocol;
    const platformOrigin = publicEnv.platformAdminHost
      ? `${appProtocol}//${publicEnv.platformAdminHost}`
      : requestUrl.origin;
    return NextResponse.redirect(new URL("/platform-login", platformOrigin), {
      status: 303,
    });
  }
  // Public origin, not request.url — behind the proxy that resolves to the
  // container's internal bind address.
  return NextResponse.redirect(new URL("/login", publicEnv.appUrl), {
    status: 303,
  });
}
