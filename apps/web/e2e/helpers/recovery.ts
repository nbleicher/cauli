import { expect, type Page } from "@playwright/test";

/**
 * Every verified enrollment hands over a fresh Recovery Code set before it
 * releases the browser. Tests that only care about what comes after the
 * handover use this to acknowledge the set and continue.
 */
export async function passRecoveryCodeHandover(page: Page) {
  await expect(page.locator(".recovery-code-list li")).toHaveCount(10, {
    timeout: 15_000,
  });
  await page
    .getByRole("button", { name: "I have saved these codes, continue" })
    .click();
}
