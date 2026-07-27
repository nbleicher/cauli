const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";

export const publicEnv = {
  supabaseUrl,
  supabaseAnonKey,
  appUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
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
