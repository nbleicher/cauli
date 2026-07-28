import Image from "next/image";
import { redirect } from "next/navigation";
import { PlatformLoginForm } from "@/components/PlatformLoginForm";
import { getPlatformAdminIdentity } from "@/lib/server/platform-auth";

const lockNotices: Record<string, string> = {
  inactivity:
    "Your Platform Admin session locked after 15 minutes without activity.",
  absolute: "Platform Admin sessions end after one hour.",
  security:
    "The Platform Admin security boundary could not verify this session.",
};

export default async function PlatformLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ locked?: string; security?: string }>;
}) {
  if (await getPlatformAdminIdentity()) redirect("/platform-admin");
  const { locked, security } = await searchParams;
  const notice = locked
    ? lockNotices[locked]
    : security
      ? "Platform Admin MFA status is temporarily unavailable."
      : undefined;

  return (
    <main className="auth-page platform-auth-page">
      <section className="auth-panel">
        <Image
          src="/cal-head.png"
          alt=""
          width={64}
          height={64}
          className="auth-cal"
          priority
        />
        <p className="eyebrow">Separate control plane</p>
        <h1>Platform Admin</h1>
        <p className="muted">
          Cloudflare Access and a verified authenticator are required.
        </p>
        {notice && (
          <p className="form-error" role="status">
            {notice}
          </p>
        )}
        <PlatformLoginForm />
      </section>
    </main>
  );
}
