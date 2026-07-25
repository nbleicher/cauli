import { CheckCircle2, Circle, Database, Server, Terminal } from "lucide-react";
import Image from "next/image";
import { isServiceRoleConfigured, isSupabaseConfigured } from "@/lib/env";

const steps = [
  {
    title: "Create a Supabase project",
    body: "Apply the migration in supabase/migrations, then copy the project URL and API keys.",
    icon: Database,
  },
  {
    title: "Configure Railway",
    body: "Set the variables from apps/web/.env.example on both the web and worker services.",
    icon: Server,
  },
  {
    title: "Bootstrap the admin",
    body: "Run npm run bootstrap -w @calllog/web after setting BOOTSTRAP_ADMIN_EMAIL.",
    icon: Terminal,
  },
];

export default function SetupPage() {
  const publicReady = isSupabaseConfigured();
  const serviceReady = isServiceRoleConfigured();

  return (
    <main className="auth-page">
      <section className="setup-panel">
        <div className="brand brand-large">
          <Image
            src="/cal-head.png"
            alt=""
            width={30}
            height={30}
            className="brand-cal"
            priority
          />
          <span>
            cauli<span className="brand-dot">.</span>
          </span>
        </div>
        <p className="eyebrow">Environment setup</p>
        <h1>Connect the application backend</h1>
        <p className="muted setup-intro">
          The application build is running. Complete these one-time steps to
          enable authentication, recording uploads, and processing.
        </p>

        <div className="setup-status">
          <div>
            {publicReady ? <CheckCircle2 size={18} /> : <Circle size={18} />}
            Supabase public configuration
          </div>
          <div>
            {serviceReady ? <CheckCircle2 size={18} /> : <Circle size={18} />}
            Server service-role configuration
          </div>
        </div>

        <ol className="setup-steps">
          {steps.map(({ title, body, icon: Icon }, index) => (
            <li key={title}>
              <span className="setup-step-number">{index + 1}</span>
              <Icon size={20} />
              <div>
                <strong>{title}</strong>
                <p>{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
