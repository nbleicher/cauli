import { AppShell } from "@/components/AppShell";
import { requirePageAuth } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, member } = await requirePageAuth();
  return (
    <AppShell email={user.email} role={member.role}>
      {children}
    </AppShell>
  );
}
