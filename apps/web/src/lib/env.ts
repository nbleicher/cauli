function configuredValue(primary: string | undefined, legacy?: string) {
  return primary?.trim() || legacy?.trim() || "";
}

const supabaseUrl = configuredValue(
  process.env.SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_URL
);
const supabaseAnonKey = configuredValue(
  process.env.SUPABASE_ANON_KEY,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
const cspMode: "report-only" | "enforce" =
  process.env.CSP_MODE === "report-only" ? "report-only" : "enforce";

export const publicEnv = {
  supabaseUrl,
  supabaseAnonKey,
  appUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  platformAdminHost: (process.env.PLATFORM_ADMIN_HOST ?? "")
    .trim()
    .toLowerCase(),
  cspMode,
  hstsIncludeSubdomains:
    process.env.HSTS_INCLUDE_SUBDOMAINS?.toLowerCase() === "true",
};

export function isSupabaseConfigured() {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

export function requireSupabaseEnv() {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase is not configured");
  }
  return {
    url: supabaseUrl,
    anonKey: supabaseAnonKey,
  };
}
