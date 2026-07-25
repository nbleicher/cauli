import Image from "next/image";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/server/auth";
import { isSupabaseConfigured } from "@/lib/env";
import { LoginForm } from "@/components/LoginForm";

export default async function LoginPage() {
  if (!isSupabaseConfigured()) redirect("/setup");
  if (await getAuthContext()) redirect("/record");

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
        <p className="eyebrow">Private team workspace</p>
        <h1>Sign in to your calls</h1>
        <p className="muted">
          Use the email address your workspace admin invited.
        </p>
        <LoginForm />
      </section>
    </main>
  );
}
