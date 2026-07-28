import Image from "next/image";
import Link from "next/link";
import { ArrowRight, AudioLines, ShieldCheck, Sparkles } from "lucide-react";
import { PublicFooter } from "@/components/PublicFooter";
import { publicEnv } from "@/lib/env";

export default function HomePage() {
  const loginHref = new URL("/login", publicEnv.appUrl).toString();
  return (
    <main className="public-site">
      <header className="public-nav">
        <Link className="brand brand-large" href="/" aria-label="Cauli home">
          <span>
            cauli<span className="brand-dot">.</span>
          </span>
        </Link>
        <Link className="button button-primary" href={loginHref}>
          Log in
          <ArrowRight size={16} />
        </Link>
      </header>

      <section className="public-hero">
        <div className="public-hero-copy">
          <p className="eyebrow">Call quality, made actionable</p>
          <h1>Capture the conversation. Improve the next one.</h1>
          <p>
            Cauli turns browser-based calls into durable recordings,
            transcripts, and structured quality reviews for focused agency
            teams.
          </p>
          <Link className="button button-primary public-cta" href={loginHref}>
            Log in to your Workspace
            <ArrowRight size={17} />
          </Link>
        </div>
        <div className="public-mascot" aria-hidden="true">
          <Image src="/cal-head.png" alt="" width={176} height={176} priority />
        </div>
      </section>

      <section className="public-features" aria-label="Product capabilities">
        <article>
          <AudioLines size={22} />
          <h2>Durable capture</h2>
          <p>Record locally first, then process safely in the background.</p>
        </article>
        <article>
          <Sparkles size={22} />
          <h2>Review with context</h2>
          <p>Use transcripts, scorecards, and revision history together.</p>
        </article>
        <article>
          <ShieldCheck size={22} />
          <h2>Workspace controls</h2>
          <p>Keep roles, retention, exports, and privileged actions visible.</p>
        </article>
      </section>

      <p className="public-pilot-note">
        Cauli is currently available through an invite-only controlled pilot.
      </p>
      <PublicFooter />
    </main>
  );
}
