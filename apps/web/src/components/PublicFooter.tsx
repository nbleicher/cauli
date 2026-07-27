import Link from "next/link";

export function PublicFooter() {
  return (
    <footer className="public-footer">
      <span>© {new Date().getFullYear()} Cauli</span>
      <nav aria-label="Policy links">
        <Link href="/legal/terms">Terms</Link>
        <Link href="/legal/privacy">Privacy</Link>
        <Link href="/legal/subprocessors">Subprocessors</Link>
        <Link href="/legal/retention-deletion">Retention</Link>
        <Link href="/legal/security">Regulated-Use Disclaimer</Link>
      </nav>
    </footer>
  );
}
