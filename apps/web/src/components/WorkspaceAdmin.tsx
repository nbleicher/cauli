"use client";

import { RETENTION_DAY_OPTIONS, type Role } from "@calllog/shared";
import {
  LoaderCircle,
  MailPlus,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserRound,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  status: "active" | "suspended" | "former";
  joinedAt: string;
  mfaEnabled: boolean;
}

interface Invite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

/**
 * Authority-changing actions need a second factor presented recently, not just
 * a session that once had one. When the server says the assertion is stale,
 * send the Admin to re-present it and come straight back.
 */
function reassertIfRequired(result: { reassert?: boolean }) {
  if (!result?.reassert) return false;
  window.location.assign(
    `/auth/mfa?next=${encodeURIComponent(window.location.pathname)}`
  );
  return true;
}

export function WorkspaceAdmin({
  members,
  invites,
  currentUserId,
  retentionDays,
  recoveryLockouts = [],
}: {
  members: Member[];
  invites: Invite[];
  currentUserId: string;
  retentionDays: number;
  recoveryLockouts?: string[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function changeRetention(days: number) {
    setWorking("retention");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/retention", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays: days }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (reassertIfRequired(result)) return;
        throw new Error(result.error || "Retention Policy update failed");
      }
      setNotice(
        `Calls are now deleted ${result.retentionDays} days after they are recorded.`
      );
      router.refresh();
    } catch (retentionError) {
      setError(
        retentionError instanceof Error
          ? retentionError.message
          : "Retention Policy update failed"
      );
    } finally {
      setWorking("");
    }
  }

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
      if (!response.ok) {
        if (reassertIfRequired(result)) return;
        throw new Error(result.error || "Invitation failed");
      }
      setEmail("");
      router.refresh();
    } catch (inviteError) {
      setError(
        inviteError instanceof Error ? inviteError.message : "Invitation failed"
      );
    } finally {
      setWorking("");
    }
  }

  async function updateMember(
    userId: string,
    change: { role: Role } | { status: Member["status"] }
  ) {
    const action = "role" in change ? `role:${userId}` : `status:${userId}`;
    setWorking(action);
    setError("");
    try {
      const response = await fetch(`/api/admin/members/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (reassertIfRequired(result)) return;
        throw new Error(result.error || "Member update failed");
      }
      router.refresh();
    } catch (memberError) {
      setError(
        memberError instanceof Error
          ? memberError.message
          : "Member update failed"
      );
    } finally {
      setWorking("");
    }
  }

  async function removeMember(userId: string) {
    setWorking(`remove:${userId}`);
    setError("");
    try {
      const response = await fetch(`/api/admin/members/${userId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (reassertIfRequired(result)) return;
        throw new Error(result.error || "Member removal failed");
      }
      router.refresh();
    } catch (memberError) {
      setError(
        memberError instanceof Error
          ? memberError.message
          : "Member removal failed"
      );
    } finally {
      setWorking("");
    }
  }

  async function resetMfa(userId: string, email: string) {
    setWorking(`mfa:${userId}`);
    setError("");
    try {
      const response = await fetch(`/api/admin/members/${userId}/mfa`, {
        method: "DELETE",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (reassertIfRequired(result)) return;
        throw new Error(result.error || "Could not reset two-factor");
      }
      setNotice(
        result.removed
          ? `Two-factor reset for ${email}. They can sign in with their password and enroll a new device.`
          : `${email} did not have two-factor enabled.`
      );
      router.refresh();
    } catch (mfaError) {
      setError(
        mfaError instanceof Error
          ? mfaError.message
          : "Could not reset two-factor"
      );
    } finally {
      setWorking("");
    }
  }

  async function revokeInvite(inviteId: string) {
    setWorking(`invite:${inviteId}`);
    setError("");
    try {
      const response = await fetch(`/api/admin/invites?id=${inviteId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (reassertIfRequired(result)) return;
        throw new Error(result.error || "Invitation could not be revoked");
      }
      router.refresh();
    } catch (inviteError) {
      setError(
        inviteError instanceof Error
          ? inviteError.message
          : "Invitation could not be revoked"
      );
    } finally {
      setWorking("");
    }
  }

  return (
    <>
      {recoveryLockouts.length > 0 && (
        <p className="error-banner" role="alert">
          Recovery Code attempts are locked for{" "}
          {recoveryLockouts
            .map(
              (userId) =>
                members.find((member) => member.userId === userId)?.email ??
                "a Workspace Member"
            )
            .join(", ")}
          . Repeated failures locked recovery for one hour.
        </p>
      )}
      {error && <p className="error-banner">{error}</p>}
      {notice && <p className="notice-banner">{notice}</p>}
      <section className="admin-section">
        <div className="section-heading">
          <div>
            <h2>Invite a Workspace Member</h2>
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
              placeholder="member@company.com"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="invite-role">Role</label>
            <select
              id="invite-role"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              <option value="member">Member</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button
            className="button button-primary"
            disabled={working === "invite"}
          >
            {working === "invite" ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <MailPlus size={16} />
            )}
            Send invite
          </button>
        </form>
      </section>

      <section className="admin-section">
        <div className="section-heading">
          <div>
            <h2>Workspace members</h2>
            <p>
              {members.filter((member) => member.status === "active").length}{" "}
              active member
              {members.filter((member) => member.status === "active").length ===
              1
                ? ""
                : "s"}{" "}
              · {members.length} total
            </p>
          </div>
        </div>
        <div className="member-list">
          {members.map((member) => (
            <div className="member-row" key={member.userId}>
              <div className="account-avatar">
                <UserRound size={15} />
              </div>
              <div className="member-identity">
                <strong>{member.displayName || member.email}</strong>
                <span>{member.email}</span>
              </div>
              {member.mfaEnabled && member.userId !== currentUserId ? (
                <button
                  className="mfa-reset on"
                  title={`Reset two-factor for ${member.email}`}
                  disabled={Boolean(working)}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Reset two-factor for ${member.email}?\n\n${
                          member.role === "member"
                            ? "They will be able to sign in with just their password until they enroll a new device."
                            : "Their role requires two-factor, so they cannot sign in again until they enroll a new device."
                        }`
                      )
                    )
                      void resetMfa(member.userId, member.email);
                  }}
                >
                  {working === `mfa:${member.userId}` ? (
                    <LoaderCircle className="spin" size={13} />
                  ) : (
                    <ShieldCheck size={13} />
                  )}
                  <span>2FA on</span>
                </button>
              ) : member.mfaEnabled ? (
                // Replacing your own factor is Recovery Code work; another
                // Workspace Admin has to reset it for you.
                <span
                  className="mfa-reset on"
                  title="Another Workspace Admin must reset your second factor"
                >
                  <ShieldCheck size={13} />
                  <span>2FA on</span>
                </span>
              ) : (
                <span
                  className="mfa-reset off"
                  title="No second factor enrolled"
                >
                  <ShieldOff size={13} />
                  <span>No 2FA</span>
                </span>
              )}
              <select
                value={member.role}
                disabled={Boolean(working) || member.status !== "active"}
                onChange={(event) =>
                  void updateMember(member.userId, {
                    role: event.target.value as Role,
                  })
                }
                aria-label={`Role for ${member.email}`}
              >
                <option value="member">Member</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
              <select
                value={member.status}
                disabled={Boolean(working)}
                onChange={(event) =>
                  void updateMember(member.userId, {
                    status: event.target.value as Member["status"],
                  })
                }
                aria-label={`Status for ${member.email}`}
              >
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="former">Former</option>
              </select>
              <button
                className="icon-button"
                title={
                  member.userId === currentUserId
                    ? "Remove your membership"
                    : "Remove member"
                }
                aria-label={`Remove ${member.email}`}
                disabled={Boolean(working)}
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${member.email} from this workspace?`
                    )
                  ) {
                    void removeMember(member.userId);
                  }
                }}
              >
                {working === `remove:${member.userId}` ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Trash2 size={15} />
                )}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="admin-section">
        <div className="section-heading">
          <div>
            <h2>Retention Policy</h2>
            <p>
              Every Call and everything derived from it is permanently deleted
              this long after it was recorded. There is no retain-forever option
              and no per-Call exception.
            </p>
          </div>
        </div>
        <div className="field">
          <label htmlFor="retention-days">Delete Calls after</label>
          <select
            id="retention-days"
            value={retentionDays}
            disabled={Boolean(working)}
            onChange={(event) =>
              void changeRetention(Number(event.target.value))
            }
          >
            {RETENTION_DAY_OPTIONS.map((days) => (
              <option key={days} value={days}>
                {days} days
              </option>
            ))}
          </select>
        </div>
      </section>

      {invites.length > 0 && (
        <section className="admin-section">
          <div className="section-heading">
            <div>
              <h2>Pending invitations</h2>
              <p>
                Users appear above once they accept their secure sign-in link.
              </p>
            </div>
          </div>
          <div className="member-list">
            {invites.map((invite) => (
              <div className="member-row invite-row" key={invite.id}>
                <div className="account-avatar">
                  <MailPlus size={15} />
                </div>
                <div className="member-identity">
                  <strong>{invite.email}</strong>
                  <span>
                    Expires {new Date(invite.expiresAt).toLocaleDateString()}
                  </span>
                </div>
                <span className="status-pill">{invite.role}</span>
                <button
                  className="icon-button"
                  title={`Revoke invitation for ${invite.email}`}
                  aria-label={`Revoke invitation for ${invite.email}`}
                  disabled={Boolean(working)}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Revoke the invitation for ${invite.email}?`
                      )
                    ) {
                      void revokeInvite(invite.id);
                    }
                  }}
                >
                  {working === `invite:${invite.id}` ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Trash2 size={15} />
                  )}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
