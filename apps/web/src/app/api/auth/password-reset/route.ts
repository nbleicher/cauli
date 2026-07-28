import { NextResponse } from "next/server";
import { z } from "zod";
import { publicEnv } from "@/lib/env";
import { parseJson } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const schema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
});

export async function POST(request: Request) {
  const parsed = await parseJson(request, schema);
  if (parsed.error) return parsed.error;
  const supabase = await createServerSupabaseClient();
  await supabase.functions.invoke("identity-admin", {
    body: {
      action: "request_password_reset",
      email: parsed.data.email,
      redirectTo: `${publicEnv.appUrl}/auth/callback?next=/auth/password-reset`,
    },
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}
