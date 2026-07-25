const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";

export const publicEnv = {
  supabaseUrl,
  supabaseAnonKey,
  appUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
};

export const serverEnv = {
  ...publicEnv,
  serviceRoleKey,
  bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() ?? "",
};

export function isSupabaseConfigured() {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

export function isServiceRoleConfigured() {
  return Boolean(isSupabaseConfigured() && serviceRoleKey);
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

export function requireServiceRoleEnv() {
  const publicConfig = requireSupabaseEnv();
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  }
  return {
    ...publicConfig,
    serviceRoleKey,
  };
}
