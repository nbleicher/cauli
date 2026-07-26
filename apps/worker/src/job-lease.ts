interface JobLeaseHeartbeatOptions {
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export function startJobLeaseHeartbeat(
  renew: () => Promise<boolean>,
  options: JobLeaseHeartbeatOptions = {}
) {
  let ownsLease = true;
  let stopped = false;
  let pendingRenewal = Promise.resolve();

  const renewLease = () => {
    pendingRenewal = pendingRenewal.then(async () => {
      if (stopped || !ownsLease) return;
      try {
        ownsLease = await renew();
      } catch (error) {
        options.onError?.(error);
      }
    });
  };

  const timer = setInterval(renewLease, options.intervalMs ?? 60_000);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pendingRenewal;
      return ownsLease;
    },
  };
}
