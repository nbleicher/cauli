import { NextResponse } from "next/server";

const allowedKeys = new Set([
  "blocked-uri",
  "disposition",
  "effective-directive",
  "status-code",
  "violated-directive",
]);

function scrubValue(key: string, item: unknown) {
  if (typeof item !== "string" && typeof item !== "number") return undefined;
  if (key !== "blocked-uri" || typeof item !== "string") return item;
  if (!item.includes("://")) return item.slice(0, 80);
  try {
    return new URL(item).origin;
  } catch {
    return "invalid-url";
  }
}

function scrubReport(value: unknown) {
  if (typeof value !== "object" || value === null) return {};
  const source =
    "csp-report" in value &&
    typeof value["csp-report"] === "object" &&
    value["csp-report"] !== null
      ? value["csp-report"]
      : value;
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => allowedKeys.has(key))
      .map(([key, item]) => [key, scrubValue(key, item)])
      .filter(([, item]) => item !== undefined)
  );
}

export async function POST(request: Request) {
  try {
    const report = scrubReport(await request.json());
    console.warn("security.csp_violation", report);
  } catch {
    console.warn("security.csp_violation", { malformed: true });
  }
  return new NextResponse(null, { status: 204 });
}
