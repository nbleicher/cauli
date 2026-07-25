import { NextResponse } from "next/server";
import { publicEnv } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  // Public origin, not request.url — behind the proxy that resolves to the
  // container's internal bind address.
  return NextResponse.redirect(new URL("/login", publicEnv.appUrl), { status: 303 });
}
