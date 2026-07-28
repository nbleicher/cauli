-- Budget Paused is a waiting state, not a failure, so it needs its own value on
-- both the job and the Call rather than borrowing 'failed' or 'queued'. New
-- enum values cannot be used in the transaction that adds them, so this
-- migration only widens the types and the behaviour follows in the next one.

alter type public.job_status add value if not exists 'budget_paused';
alter type public.call_status add value if not exists 'budget_paused';
