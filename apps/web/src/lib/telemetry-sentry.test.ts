import { describe, expect, it } from "vitest";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  webTraceSampleRate,
} from "./telemetry-sentry";

describe("Sentry runtime policy", () => {
  it("uses request routes for critical, routine, and excluded traces", () => {
    expect(
      webTraceSampleRate(
        {
          name: "POST /api/calls/[id]/finalize",
          normalizedRequest: {
            url: "https://app.cauli.pro/api/calls/1/finalize",
          },
        },
        {}
      )
    ).toBe(1);
    expect(
      webTraceSampleRate(
        {
          name: "GET /workspace",
          normalizedRequest: { url: "https://app.cauli.pro/workspace" },
        },
        {}
      )
    ).toBe(0.1);
    expect(
      webTraceSampleRate(
        {
          name: "GET /api/health",
          normalizedRequest: { url: "https://app.cauli.pro/api/health" },
        },
        {}
      )
    ).toBe(0);
  });

  it("retains error class and route but denies free-form prose", () => {
    const event = scrubSentryEvent({
      transaction: "/record",
      exception: {
        values: [
          {
            type: "ProviderError",
            value: "Customer agreed to confidential acquisition",
          },
        ],
      },
    });
    expect(event.transaction).toBe("/record");
    expect(event.exception.values[0]).toEqual({
      type: "ProviderError",
      value: "[redacted]",
    });
  });

  it("drops console breadcrumbs entirely", () => {
    expect(
      scrubSentryBreadcrumb({
        category: "console",
        message: "Call title",
      })
    ).toBeNull();
  });
});
