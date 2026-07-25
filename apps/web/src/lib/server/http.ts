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
