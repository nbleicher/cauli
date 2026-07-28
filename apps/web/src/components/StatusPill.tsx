import type { CallStatus, ReviewStatus } from "@calllog/shared";

export function StatusPill({ status }: { status: CallStatus | ReviewStatus }) {
  const label =
    status === "failed"
      ? "needs attention"
      : status === "budget_paused"
        ? "budget paused"
        : status.replaceAll("_", " ");
  return <span className={`status-pill status-${status}`}>{label}</span>;
}
