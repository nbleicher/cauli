"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const PROCESSING_POLL_INTERVAL_MS = 5_000;

export function ProcessingPoller({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => {
      router.refresh();
    }, PROCESSING_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [active, router]);

  return null;
}
