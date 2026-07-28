import type { Role } from "@calllog/shared";
import {
  ClipboardCheck,
  FileClock,
  Headphones,
  ListTodo,
  LogOut,
  Mic2,
  TriangleAlert,
  Settings2,
  ShieldCheck,
  Users,
} from "lucide-react";
import Image from "next/image";
import { NavItem } from "@/components/NavItem";

interface AppShellProps {
  children: React.ReactNode;
  email: string;
  needsAttentionCount?: number;
  role: Role;
}

const memberNav = [
  { href: "/record", label: "Record", icon: Mic2 },
  { href: "/calls", label: "My Calls", icon: Headphones },
  { href: "/follow-ups", label: "Follow-ups", icon: ListTodo },
];

const accountNav = [{ href: "/account", label: "Account", icon: ShieldCheck }];

const managerNav = [
  { href: "/workspace", label: "Workspace Calls", icon: ClipboardCheck },
];

const adminNav = [
  { href: "/admin/attention", label: "Needs Attention", icon: TriangleAlert },
  { href: "/admin/audit", label: "Audit Log", icon: FileClock },
  { href: "/admin/workspace", label: "Workspace Admin", icon: Users },
  { href: "/admin/scorecards", label: "Scorecards", icon: Settings2 },
];

export function AppShell({
  children,
  email,
  needsAttentionCount = 0,
  role,
}: AppShellProps) {
  const nav = [
    ...memberNav,
    ...(role === "manager" || role === "admin" ? managerNav : []),
    ...(role === "admin" ? adminNav : []),
    ...accountNav,
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Image
            src="/cal-head.png"
            alt=""
            width={26}
            height={26}
            className="brand-cal"
            priority
          />
          <span>
            cauli<span className="brand-dot">.</span>
          </span>
        </div>
        <nav className="side-nav" aria-label="Primary navigation">
          {nav.map(({ href, label, icon: Icon }) => (
            <NavItem
              key={href}
              href={href}
              label={label}
              badge={
                href === "/admin/attention" ? needsAttentionCount : undefined
              }
            >
              <Icon size={18} />
            </NavItem>
          ))}
        </nav>
        <div className="account-block">
          <div className="account-avatar">
            {email.slice(0, 1).toUpperCase()}
          </div>
          <div className="account-copy">
            <span title={email}>{email}</span>
            <small>{role}</small>
          </div>
          <form action="/api/auth/signout" method="post">
            <button
              className="icon-button"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={16} />
            </button>
          </form>
        </div>
      </aside>
      <div className="app-content">{children}</div>
    </div>
  );
}
