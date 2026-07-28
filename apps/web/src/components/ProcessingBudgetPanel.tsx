import { AlertTriangle, CircleDollarSign } from "lucide-react";

export interface ProcessingBudgetStatus {
  dailyLimitUsd: number;
  spentTodayUsd: number;
  warningRatio: number;
  pausedJobCount: number;
  pausedReason:
    "workspace_limit" | "platform_limit" | "pricing_unconfigured" | null;
}

const PAUSE_EXPLANATIONS: Record<string, string> = {
  workspace_limit:
    "This Workspace has reached its daily processing budget. Transcription resumes when the budget resets or a Cauli operator raises the limit.",
  platform_limit:
    "Cauli has reached its platform-wide daily processing budget. Transcription resumes when the budget resets or a Cauli operator raises the limit.",
  pricing_unconfigured:
    "Transcription pricing is not configured for the active model, so Cauli is holding this work rather than spending against an unknown price.",
};

function usd(amount: number) {
  return `$${amount.toFixed(2)}`;
}

export function ProcessingBudgetPanel({
  status,
}: {
  status: ProcessingBudgetStatus;
}) {
  const share =
    status.dailyLimitUsd > 0 ? status.spentTodayUsd / status.dailyLimitUsd : 0;
  const warning = share >= status.warningRatio;

  return (
    <section className="admin-section">
      <div className="section-heading">
        <div>
          <h2>Processing budget</h2>
          <p>
            Daily transcription spending for this Workspace. Budgets are set by
            Cauli operators and cannot be changed here.
          </p>
        </div>
        <CircleDollarSign size={17} />
      </div>
      <dl className="call-facts">
        <div>
          <dt>Daily limit</dt>
          <dd className="mono">{usd(status.dailyLimitUsd)}</dd>
        </div>
        <div>
          <dt>Spent today</dt>
          <dd className="mono">{usd(status.spentTodayUsd)}</dd>
        </div>
        <div>
          <dt>Waiting for budget</dt>
          <dd className="mono">{status.pausedJobCount}</dd>
        </div>
      </dl>
      {warning && status.pausedJobCount === 0 && (
        <p className="field-hint" role="status">
          This Workspace has used {Math.round(share * 100)}% of today&rsquo;s
          processing budget.
        </p>
      )}
      {status.pausedJobCount > 0 && (
        <div className="processing-error">
          <div>
            <AlertTriangle size={17} />
            <span>
              {PAUSE_EXPLANATIONS[status.pausedReason ?? "workspace_limit"]}{" "}
              Recording and Source Audio are unaffected.
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
