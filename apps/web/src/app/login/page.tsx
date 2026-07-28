import Image from "next/image";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/server/auth";
import { isSupabaseConfigured } from "@/lib/env";
import { LoginForm } from "@/components/LoginForm";
import { PublicFooter } from "@/components/PublicFooter";

const lockNotices: Record<string, string> = {
  inactivity:
    "Your session locked after 30 minutes without activity. Sign in again to continue.",
  absolute: "Sessions end after 12 hours. Sign in again to continue.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ locked?: string }>;
}) {
  if (!isSupabaseConfigured()) redirect("/setup");
  if (await getAuthContext()) redirect("/record");
  const { locked } = await searchParams;
  const lockNotice = locked ? lockNotices[locked] : undefined;

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <Image
          src="/cal-head.png"
          alt="Cal, the cauli mascot"
          width={72}
          height={72}
          className="auth-cal"
          priority
        />
        <div className="brand brand-large">
          <span>
            cauli<span className="brand-dot">.</span>
          </span>
        </div>
        <p className="eyebrow">Private Workspace</p>
        <h1>Sign in to your calls</h1>
        <p className="muted">
          Use the email address your workspace admin invited.
        </p>
        {lockNotice && (
          <p className="form-error" role="status">
            {lockNotice}
          </p>
        )}
        <LoginForm />
      </section>
      <PublicFooter />
    </main>
  );
}
