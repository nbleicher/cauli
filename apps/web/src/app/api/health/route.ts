import { NextResponse } from "next/server";
import { isServiceRoleConfigured, isSupabaseConfigured } from "@/lib/env";

export function GET() {
  const configured = isSupabaseConfigured() && isServiceRoleConfigured();
  return NextResponse.json({
    ok: true,
    configured,
    service: "calllog-web",
    timestamp: new Date().toISOString(),
  });
}
