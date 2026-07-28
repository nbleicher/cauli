import { expect, test } from "@playwright/test";

test("public product page routes Log in to the configured application", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);
  await expect(
    page.getByRole("heading", {
      name: "Capture the conversation. Improve the next one.",
    })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Log in", exact: true })
  ).toHaveAttribute("href", "http://127.0.0.1:3102/login");
  await expect(
    page.getByRole("navigation", { name: "Policy links" })
  ).toBeVisible();

  const headers = response?.headers() ?? {};
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["content-security-policy"]).toMatch(
    /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/
  );
});
