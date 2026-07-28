import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/server/auth";
import { sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Issues a fresh set of Recovery Codes and invalidates any previous set. This
// deliberately does not use requireApiAuth: it runs immediately after a factor
// is verified, while the Legal Document gate may still be closed. The identity
// endpoint enforces the assurance level itself.
export async function POST() {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.functions.invoke("identity-admin", {
    body: { action: "issue_recovery_codes" },
  });
  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  // Plaintext codes pass straight through to the one screen that shows them;
  // nothing on this side stores or logs them.
  return NextResponse.json(data, { status: 201 });
}
