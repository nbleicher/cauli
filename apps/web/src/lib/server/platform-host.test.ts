import { describe, expect, it } from "vitest";
import {
  isPlatformAdminHost,
  isPlatformAdminPath,
  platformHostAllowsPath,
} from "./platform-host";

describe("Platform Admin host boundary", () => {
  it("recognizes only the dedicated control-plane routes", () => {
    expect(isPlatformAdminPath("/platform-login")).toBe(true);
    expect(isPlatformAdminPath("/platform-admin")).toBe(true);
    expect(isPlatformAdminPath("/api/platform-admin/grants")).toBe(true);
    expect(isPlatformAdminPath("/admin/workspace")).toBe(false);
    expect(isPlatformAdminPath("/calls")).toBe(false);
  });

  it("requires the configured host outside local development", () => {
    expect(
      isPlatformAdminHost("admin.cauli.pro", "admin.cauli.pro", false)
    ).toBe(true);
    expect(isPlatformAdminHost("app.cauli.pro", "admin.cauli.pro", false)).toBe(
      false
    );
    expect(isPlatformAdminHost("127.0.0.1:3102", "", true)).toBe(true);
    expect(isPlatformAdminHost("admin.cauli.pro", "", false)).toBe(false);
  });

  it("does not expose Workspace application routes on the admin host", () => {
    expect(platformHostAllowsPath("/platform-admin")).toBe(true);
    expect(platformHostAllowsPath("/auth/mfa?platform=1")).toBe(true);
    expect(platformHostAllowsPath("/record")).toBe(false);
    expect(platformHostAllowsPath("/admin/workspace")).toBe(false);
  });
});
