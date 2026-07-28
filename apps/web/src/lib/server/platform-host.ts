function normalizeHost(host: string) {
  return host.trim().toLowerCase().split(":")[0] ?? "";
}

export function isPlatformAdminPath(pathname: string) {
  return (
    pathname === "/platform-login" ||
    pathname.startsWith("/platform-admin") ||
    pathname.startsWith("/api/platform-admin")
  );
}

export function isPlatformAdminHost(
  host: string,
  configuredHost: string,
  development: boolean
) {
  const hostname = normalizeHost(host);
  if (configuredHost) return hostname === normalizeHost(configuredHost);
  return development && (hostname === "localhost" || hostname === "127.0.0.1");
}

export function platformHostAllowsPath(pathname: string) {
  return (
    pathname === "/" ||
    pathname === "/platform-login" ||
    pathname.startsWith("/platform-admin") ||
    pathname.startsWith("/api/platform-admin") ||
    pathname.startsWith("/auth/mfa") ||
    pathname.startsWith("/api/auth/signout") ||
    pathname.startsWith("/api/health")
  );
}
