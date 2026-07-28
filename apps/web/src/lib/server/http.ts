import { NextResponse } from "next/server";
import type { ZodType } from "zod";

export async function parseJson<T>(request: Request, schema: ZodType<T>) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      data: null,
      error: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    };
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    return {
      data: null,
      error: NextResponse.json(
        {
          error: "Validation failed",
          issues: result.error.issues,
        },
        { status: 400 }
      ),
    };
  }
  return { data: result.data, error: null };
}

/**
 * Turns the database's limit refusal into the status that means it. The limits
 * live on the tables, so this only has to recognise the verdict, and 53400
 * (configuration_limit_exceeded) is the code every abuse guard raises with.
 */
export async function rateLimitResponse(
  error: unknown,
  supabase?: { rpc: (name: string, args: object) => PromiseLike<unknown> },
  bucket?: string
) {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code !== "53400") return null;
  // The refusal aborted the transaction that would have carried the database's
  // own Audit Event, so the evidence is written here instead, after the fact.
  if (supabase && bucket) {
    await supabase.rpc("record_rate_limit_evidence", {
      target_bucket: bucket,
    });
  }
  return NextResponse.json({ error: sanitizeError(error) }, { status: 429 });
}

export function sanitizeError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "Unknown error";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(?:sk-or-v1-|sb_secret_)[A-Za-z0-9_-]+\b/g,
      "[credential-redacted]"
    )
    .replace(
      /https?:\/\/\S*(?:token|signature|signed)\S*/gi,
      "[signed-url-redacted]"
    )
    .slice(0, 1_000);
}
