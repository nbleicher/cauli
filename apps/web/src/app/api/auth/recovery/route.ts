import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const recoverySchema = z.object({
  password: z.string().min(1),
  code: z.string().min(1).max(64),
});

// Redeems one Recovery Code. Success removes every enrolled factor and leaves
// the account owing a replacement, so this route sits below the MFA gate on
// purpose — a signed-in session that cannot reach the application is exactly
// the session that needs it. Password verification happens inside the identity
// endpoint, which is also the only principal that may delete a factor.
export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = await parseJson(request, recoverySchema);
  if (parsed.error) return parsed.error;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.functions.invoke("identity-admin", {
    body: {
      action: "redeem_recovery_code",
      password: parsed.data.password,
      code: parsed.data.code,
    },
  });
  if (error) {
    const status =
      (error as { context?: { status?: number } }).context?.status ?? 500;
    // Wrong password and wrong code are answered identically so neither can be
    // probed independently.
    if (status === 401) {
      return NextResponse.json(
        { error: "Recovery could not be verified" },
        { status: 401 }
      );
    }
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  return NextResponse.json(data);
}
