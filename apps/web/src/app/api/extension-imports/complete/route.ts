import { NextResponse } from "next/server";

export function POST() {
  return NextResponse.json(
    { error: "Legacy extension import is no longer supported" },
    { status: 410 }
  );
}
