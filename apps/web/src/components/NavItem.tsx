"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavItem({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  // The icon arrives already rendered. A component cannot be passed from a server
  // component to a client one, but its rendered element serializes fine.
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/record" && pathname.startsWith(`${href}/`));

  return (
    <Link href={href} className={`nav-item${active ? " active" : ""}`}>
      {children}
      <span>{label}</span>
    </Link>
  );
}
