type LogLevel = "info" | "warn" | "error";

function write(level: LogLevel, message: string, context: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  })}\n`);
}

export const log = {
  info: (message: string, context?: Record<string, unknown>) => write("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => write("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => write("error", message, context),
};

export function sanitizedError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown worker error";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/\S*(?:token|signature|signed)\S*/gi, "[signed-url-redacted]")
    .slice(0, 1_000);
}
