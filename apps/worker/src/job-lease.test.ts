import { afterEach, describe, expect, it, vi } from "vitest";
import { startJobLeaseHeartbeat } from "./job-lease.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("job lease heartbeat", () => {
  it("renews an active worker lease until the job finishes", async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockResolvedValue(true);
    const heartbeat = startJobLeaseHeartbeat(renew, {
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(2_500);

    expect(renew).toHaveBeenCalledTimes(2);
    await expect(heartbeat.stop()).resolves.toBe(true);
  });

  it("reports ownership loss when the lease token is rejected", async () => {
    vi.useFakeTimers();
    const heartbeat = startJobLeaseHeartbeat(async () => false, {
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(heartbeat.stop()).resolves.toBe(false);
  });
});
