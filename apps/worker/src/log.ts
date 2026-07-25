type LogLevel = "info" | "warn" | "error";

function write(
  level: LogLevel,
  message: string,
  context: Record<string, unknown> = {}
) {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    })}\n`
  );
}

export const log = {
  info: (message: string, context?: Record<string, unknown>) =>
    write("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) =>
    write("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) =>
    write("error", message, context),
};

export function sanitizedError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "Unknown worker error";
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
