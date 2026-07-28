export type CspMode = "enforce" | "report-only";

interface SecurityHeaderOptions {
  nonce: string;
  supabaseUrl: string;
  cspMode: CspMode;
  development: boolean;
  hstsIncludeSubdomains: boolean;
}

function supabaseDestinations(rawUrl: string) {
  if (!rawUrl) return [];
  try {
    const url = new URL(rawUrl);
    const websocketProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    return [url.origin, `${websocketProtocol}//${url.host}`];
  } catch {
    return [];
  }
}

export function securityHeaders({
  nonce,
  supabaseUrl,
  cspMode,
  development,
  hstsIncludeSubdomains,
}: SecurityHeaderOptions) {
  const destinations = supabaseDestinations(supabaseUrl);
  const connectSources = ["'self'", ...destinations].join(" ");
  const mediaSources = [
    "'self'",
    "blob:",
    ...destinations.filter((destination) => !destination.startsWith("ws")),
  ].join(" ");
  const scriptSources = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(development ? ["'unsafe-eval'"] : []),
  ].join(" ");
  const styleSources = development
    ? "'self' 'unsafe-inline'"
    : `'self' 'nonce-${nonce}'`;
  const policy = [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    `style-src ${styleSources}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSources}`,
    `media-src ${mediaSources}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "report-uri /api/security/csp-report",
  ].join("; ");

  const headers: Record<string, string> = {
    [cspMode === "report-only"
      ? "Content-Security-Policy-Report-Only"
      : "Content-Security-Policy"]: policy,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      "microphone=(self), display-capture=(self), fullscreen=(self), clipboard-write=(self), camera=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  if (hstsIncludeSubdomains) {
    headers["Strict-Transport-Security"] =
      "max-age=31536000; includeSubDomains";
  }
  return headers;
}
