import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";

export function GET() {
  const configured = isSupabaseConfigured();
  return NextResponse.json({
    ok: true,
    configured,
    service: "calllog-web",
    timestamp: new Date().toISOString(),
  });
}
