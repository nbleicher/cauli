import { expect, test } from "@playwright/test";

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`setup page fits the ${viewport.name} viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/setup");

    await expect(page).toHaveTitle("cauli");
    await expect(
      page.getByRole("heading", { name: "Connect the application backend" }),
    ).toBeVisible();

    const layout = await page.locator(".setup-panel").evaluate((panel) => {
      const bounds = panel.getBoundingClientRect();
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        left: bounds.left,
        right: bounds.right,
      };
    });

    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
  });
}
