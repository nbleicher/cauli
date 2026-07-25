"use client";

import type { Role } from "@calllog/shared";
import { LoaderCircle, MailPlus, Trash2, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  joinedAt: string;
}

interface Invite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

export function TeamAdmin({
  members,
  invites,
  currentUserId,
}: {
  members: Member[];
  invites: Invite[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");

  async function invite(event: FormEvent) {
    event.preventDefault();
    setWorking("invite");
    setError("");
    try {
      const response = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Invitation failed");
      setEmail("");
      router.refresh();
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : "Invitation failed");
    } finally {
      setWorking("");
    }
  }

  async function updateMember(userId: string, nextRole?: Role) {
    const action = nextRole ? `role:${userId}` : `remove:${userId}`;
    setWorking(action);
    setError("");
    try {
      const response = await fetch(`/api/admin/members/${userId}`, {
        method: nextRole ? "PATCH" : "DELETE",
        headers: nextRole ? { "Content-Type": "application/json" } : undefined,
        body: nextRole ? JSON.stringify({ role: nextRole }) : undefined,
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Member update failed");
      }
      router.refresh();
    } catch (memberError) {
      setError(memberError instanceof Error ? memberError.message : "Member update failed");
    } finally {
      setWorking("");
    }
  }

  return (
    <>
      {error && <p className="error-banner">{error}</p>}
      <section className="admin-section">
        <div className="section-heading">
          <div>
            <h2>Invite a teammate</h2>
            <p>Invitations expire after seven days and can be resent.</p>
          </div>
        </div>
        <form className="invite-form" onSubmit={invite}>
          <div className="field">
            <label htmlFor="invite-email">Email</label>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="teammate@company.com"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="invite-role">Role</label>
            <select id="invite-role" value={role} onChange={(event) => setRole(event.target.value as Role)}>
              <option value="member">Member</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button className="button button-primary" disabled={working === "invite"}>
            {working === "invite" ? <LoaderCircle className="spin" size={16} /> : <MailPlus size={16} />}
            Send invite
          </button>
        </form>
      </section>

      <section className="admin-section">
        <div className="section-heading">
          <div>
            <h2>Workspace members</h2>
            <p>{members.length} active member{members.length === 1 ? "" : "s"}</p>
          </div>
        </div>
        <div className="member-list">
          {members.map((member) => (
            <div className="member-row" key={member.userId}>
              <div className="account-avatar"><UserRound size={15} /></div>
              <div className="member-identity">
                <strong>{member.displayName || member.email}</strong>
                <span>{member.email}</span>
              </div>
              <select
                value={member.role}
                disabled={Boolean(working)}
                onChange={(event) => void updateMember(member.userId, event.target.value as Role)}
                aria-label={`Role for ${member.email}`}
              >
                <option value="member">Member</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
              <button
                className="icon-button"
                title={member.userId === currentUserId ? "Remove your membership" : "Remove member"}
                aria-label={`Remove ${member.email}`}
                disabled={Boolean(working)}
                onClick={() => {
                  if (window.confirm(`Remove ${member.email} from this workspace?`)) {
                    void updateMember(member.userId);
                  }
                }}
              >
                {working === `remove:${member.userId}`
                  ? <LoaderCircle className="spin" size={15} />
                  : <Trash2 size={15} />}
              </button>
            </div>
          ))}
        </div>
      </section>

      {invites.length > 0 && (
        <section className="admin-section">
          <div className="section-heading">
            <div>
              <h2>Pending invitations</h2>
              <p>Users appear above once they accept their secure sign-in link.</p>
            </div>
          </div>
          <div className="member-list">
            {invites.map((invite) => (
              <div className="member-row invite-row" key={invite.id}>
                <div className="account-avatar"><MailPlus size={15} /></div>
                <div className="member-identity">
                  <strong>{invite.email}</strong>
                  <span>Expires {new Date(invite.expiresAt).toLocaleDateString()}</span>
                </div>
                <span className="status-pill">{invite.role}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
