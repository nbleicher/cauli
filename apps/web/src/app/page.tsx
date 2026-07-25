import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/server/auth";
import { isSupabaseConfigured } from "@/lib/env";

export default async function HomePage() {
  if (!isSupabaseConfigured()) redirect("/setup");
  const auth = await getAuthContext();
  redirect(auth ? "/record" : "/login");
}
