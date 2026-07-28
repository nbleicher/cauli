"use client";

import { LoaderCircle, LockKeyhole, Search, ShieldOff } from "lucide-react";
import { useState, type FormEvent } from "react";

export interface WorkspaceHealth {
  workspace_id: string;
  workspace_name: string;
  active_members: number;
  active_calls: number;
  queued_jobs: number;
  failed_jobs: number;
}

interface PlatformAdminConsoleProps {
  environment: "staging" | "production";
  workspaces: WorkspaceHealth[];
}

interface GrantResult {
  id: string;
  workspaceId: string;
  callId: string | null;
  expiresAt: string;
}

export function PlatformAdminConsole({
  environment,
  workspaces,
}: PlatformAdminConsoleProps) {
  const [workspaceId, setWorkspaceId] = useState(
    workspaces[0]?.workspace_id ?? ""
  );
  const [callId, setCallId] = useState("");
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState("30");
  const [grant, setGrant] = useState<GrantResult | null>(null);
  const [readCallId, setReadCallId] = useState("");
  const [content, setContent] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function parseResponse(response: Response) {
    const result = (await response.json().catch(() => ({}))) as {
      error?: string;
      reassert?: boolean;
      location?: string;
    };
    if (response.ok) return result;
    if (result.reassert) {
      window.location.assign(
        result.location ?? "/auth/mfa?platform=1&next=/platform-admin"
      );
      throw new Error("Reasserting MFA");
    }
    throw new Error(result.error ?? "Platform Admin action failed");
  }

  async function createGrant(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch("/api/platform-admin/grants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          callId: callId.trim() || null,
          reason,
          minutes: Number(minutes),
        }),
      });
      const result = (await parseResponse(response)) as unknown as GrantResult;
      setGrant(result);
      setReadCallId(result.callId ?? "");
      setStatus("Break-glass access activated. Workspace Admin notified.");
    } catch (error) {
      if ((error as Error).message !== "Reasserting MFA") {
        setStatus((error as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function revokeGrant() {
    if (!grant) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(
        `/api/platform-admin/grants?id=${encodeURIComponent(grant.id)}`,
        { method: "DELETE" }
      );
      await parseResponse(response);
      setGrant(null);
      setContent(null);
      setStatus("Break-glass access revoked immediately.");
    } catch (error) {
      if ((error as Error).message !== "Reasserting MFA") {
        setStatus((error as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function readContent(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    setContent(null);
    try {
      const response = await fetch(
        `/api/platform-admin/content?callId=${encodeURIComponent(readCallId)}`
      );
      const result = await parseResponse(response);
      setContent(result as Record<string, unknown>);
      setStatus("Audited break-glass read completed.");
    } catch (error) {
      if ((error as Error).message !== "Reasserting MFA") {
        setStatus((error as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="platform-console">
      <header className="platform-header">
        <div>
          <p className="eyebrow">Separate control plane · {environment}</p>
          <h1>Platform Admin</h1>
          <p>
            Operational health is visible by default. Call content remains
            closed until a narrow, expiring grant is activated.
          </p>
        </div>
        <form action="/api/auth/signout?boundary=platform" method="post">
          <button className="button button-secondary">Sign out</button>
        </form>
      </header>

      <section className="platform-card">
        <h2>Workspace health</h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Members</th>
                <th>Calls</th>
                <th>Active jobs</th>
                <th>Failed jobs</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((workspace) => (
                <tr key={workspace.workspace_id}>
                  <td>{workspace.workspace_name}</td>
                  <td>{workspace.active_members}</td>
                  <td>{workspace.active_calls}</td>
                  <td>{workspace.queued_jobs}</td>
                  <td>{workspace.failed_jobs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="platform-grid">
        <form className="platform-card platform-form" onSubmit={createGrant}>
          <LockKeyhole size={24} />
          <h2>Activate break-glass access</h2>
          <label htmlFor="grant-workspace">Workspace</label>
          <select
            id="grant-workspace"
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
            required
          >
            {workspaces.map((workspace) => (
              <option
                key={workspace.workspace_id}
                value={workspace.workspace_id}
              >
                {workspace.workspace_name}
              </option>
            ))}
          </select>
          <label htmlFor="grant-call">Call ID (optional)</label>
          <input
            id="grant-call"
            value={callId}
            onChange={(event) => setCallId(event.target.value)}
            placeholder="Blank grants this Workspace only"
          />
          <label htmlFor="grant-reason">Reason</label>
          <textarea
            id="grant-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={10}
            maxLength={500}
            required
          />
          <label htmlFor="grant-minutes">Expires after</label>
          <select
            id="grant-minutes"
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          >
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">60 minutes</option>
          </select>
          <button
            className="button button-primary"
            disabled={busy || !workspaceId}
          >
            {busy ? <LoaderCircle className="spin" size={17} /> : null}
            Activate and notify
          </button>
          {grant ? (
            <button
              className="button button-danger"
              type="button"
              onClick={() => void revokeGrant()}
              disabled={busy}
            >
              <ShieldOff size={17} />
              Revoke active grant
            </button>
          ) : null}
        </form>

        <form className="platform-card platform-form" onSubmit={readContent}>
          <Search size={24} />
          <h2>Audited content read</h2>
          <label htmlFor="read-call">Call ID</label>
          <input
            id="read-call"
            value={readCallId}
            onChange={(event) => setReadCallId(event.target.value)}
            required
          />
          <button className="button button-secondary" disabled={busy}>
            Read through active grant
          </button>
          {content ? (
            <pre className="platform-content">
              {JSON.stringify(content, null, 2)}
            </pre>
          ) : (
            <p className="muted">
              Direct table and unrestricted signed-URL access remain denied.
            </p>
          )}
        </form>
      </section>
      {status ? (
        <p className="platform-status" role="status">
          {status}
        </p>
      ) : null}
    </div>
  );
}
