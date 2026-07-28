import { describe, expect, it } from "vitest";
import { securityHeaders } from "./security-headers";

describe("securityHeaders", () => {
  it("enforces the exact production browser boundary", () => {
    const headers = securityHeaders({
      nonce: "fresh-nonce",
      supabaseUrl: "https://pilot.supabase.co",
      cspMode: "enforce",
      development: false,
      hstsIncludeSubdomains: true,
    });

    const policy = headers["Content-Security-Policy"] ?? "";
    expect(policy).toContain(
      "script-src 'self' 'nonce-fresh-nonce' 'strict-dynamic'"
    );
    expect(policy).toContain("style-src-attr 'unsafe-inline'");
    expect(policy.match(/script-src ([^;]+)/)?.[1]).not.toContain(
      "'unsafe-inline'"
    );
    expect(policy.match(/script-src ([^;]+)/)?.[1]).not.toContain(
      "'unsafe-eval'"
    );
    expect(policy).toContain(
      "connect-src 'self' https://pilot.supabase.co wss://pilot.supabase.co"
    );
    expect(policy).toContain(
      "media-src 'self' blob: https://pilot.supabase.co"
    );
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain("img-src 'self' data:");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).not.toContain("openrouter");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(headers["Strict-Transport-Security"]).toBe(
      "max-age=31536000; includeSubDomains"
    );
    expect(headers["Permissions-Policy"]).toBe(
      "microphone=(self), display-capture=(self), fullscreen=(self), clipboard-write=(self), camera=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()"
    );
  });

  it("uses report-only staging and permits development tooling only in development", () => {
    const headers = securityHeaders({
      nonce: "local",
      supabaseUrl: "http://127.0.0.1:54321",
      cspMode: "report-only",
      development: true,
      hstsIncludeSubdomains: false,
    });

    expect(headers["Content-Security-Policy"]).toBeUndefined();
    expect(headers["Content-Security-Policy-Report-Only"]).toContain(
      "connect-src 'self' http://127.0.0.1:54321 ws://127.0.0.1:54321"
    );
    expect(headers["Content-Security-Policy-Report-Only"]).toContain(
      "'unsafe-eval'"
    );
    expect(headers["Content-Security-Policy-Report-Only"]).toContain(
      "'unsafe-inline'"
    );
    expect(headers["Strict-Transport-Security"]).toBeUndefined();
  });
});
