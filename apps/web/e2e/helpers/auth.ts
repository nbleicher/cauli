import { expect, type Page, type Response } from "@playwright/test";
import { totpCode } from "./totp";

const authResponseTimeout = 15_000;
const protectedNavigationTimeout = 15_000;

interface PasswordAuthResponse {
  code?: unknown;
  error?: unknown;
  error_description?: unknown;
  msg?: unknown;
}

function isPasswordAuthResponse(response: Response) {
  const url = new URL(response.url());
  return (
    url.pathname.endsWith("/auth/v1/token") &&
    url.searchParams.get("grant_type") === "password"
  );
}

function isProtectedRecordResponse(response: Response) {
  const url = new URL(response.url());
  return (
    response.request().resourceType() === "document" &&
    url.pathname === "/record"
  );
}

export async function submitBrowserTotp(page: Page, secret: string) {
  await expect(page).toHaveURL(/\/auth\/mfa(?:\?|$)/, {
    timeout: protectedNavigationTimeout,
  });
  await page.getByLabel("Verification code").fill(totpCode(secret));
  await page.getByRole("button", { name: "Verify" }).click();
}

async function readPasswordAuthResponse(response: Response) {
  try {
    return (await response.json()) as PasswordAuthResponse;
  } catch {
    // Chromium can discard this cross-origin response body when the successful
    // sign-in immediately replaces the page. Status, cookies, and the protected
    // document response remain observable and are the authoritative signals.
    return {};
  }
}

function describeAuthFailure(response: Response, body: PasswordAuthResponse) {
  const details = [body.code, body.error, body.error_description, body.msg]
    .filter((value): value is string => typeof value === "string")
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(": ");

  return `Supabase password sign-in failed (${response.status()})${
    details ? `: ${details}` : ""
  }`;
}

async function describeProtectedNavigationFailure(page: Page, detail: string) {
  const cookies = await page.context().cookies();
  const hasSessionCookie = cookies.some(({ name }) =>
    name.includes("-auth-token")
  );
  const formError = await page
    .locator(".form-error")
    .textContent({ timeout: 250 })
    .catch(() => null);

  return [
    "Password sign-in succeeded, but the server did not authorize /record.",
    detail,
    `Current URL: ${page.url()}.`,
    `Supabase session cookie present: ${hasSessionCookie ? "yes" : "no"}.`,
    formError ? `Sign-in form error: ${formError}.` : "",
    hasSessionCookie
      ? "Verify that the authenticated user has a Workspace membership."
      : "Verify that the browser persisted the Supabase session.",
  ]
    .filter(Boolean)
    .join(" ");
}

export async function signInAsWorkspaceMember(
  page: Page,
  email: string,
  password: string,
  transientRetries = 2,
  totpSecret?: string
) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);

  const authResponsePromise = page.waitForResponse(isPasswordAuthResponse, {
    timeout: authResponseTimeout,
  });
  const protectedResponsePromise = page
    .waitForResponse(isProtectedRecordResponse, {
      timeout: protectedNavigationTimeout,
    })
    .then(
      (response) => ({ response }),
      (error: unknown) => ({ error })
    );
  await page.getByRole("button", { name: "Sign in" }).click();

  const authResponse = await authResponsePromise;
  const authBody = await readPasswordAuthResponse(authResponse);
  if (!authResponse.ok()) {
    if (
      transientRetries > 0 &&
      authResponse.status() >= 500 &&
      authBody.code === "request_timeout"
    ) {
      await page.waitForTimeout(250);
      return signInAsWorkspaceMember(
        page,
        email,
        password,
        transientRetries - 1,
        totpSecret
      );
    }
    throw new Error(describeAuthFailure(authResponse, authBody));
  }

  if (totpSecret) {
    await protectedResponsePromise;
    const verifiedRecordResponse = page.waitForResponse(
      isProtectedRecordResponse,
      { timeout: protectedNavigationTimeout }
    );
    await submitBrowserTotp(page, totpSecret);
    const recordResponse = await verifiedRecordResponse;
    if (!recordResponse.ok()) {
      throw new Error(
        await describeProtectedNavigationFailure(
          page,
          `/record responded with ${recordResponse.status()} after TOTP verification.`
        )
      );
    }
    await expect(page).toHaveURL(/\/record$/, {
      timeout: protectedNavigationTimeout,
    });
    return;
  }

  const protectedResult = await protectedResponsePromise;
  if ("error" in protectedResult) {
    const detail =
      protectedResult.error instanceof Error
        ? protectedResult.error.message
        : String(protectedResult.error);
    throw new Error(
      await describeProtectedNavigationFailure(
        page,
        `No /record document response arrived within ${protectedNavigationTimeout}ms. ${detail}`
      )
    );
  }
  if (!protectedResult.response.ok()) {
    const location = protectedResult.response.headers().location;
    throw new Error(
      await describeProtectedNavigationFailure(
        page,
        `/record responded with ${protectedResult.response.status()}${
          location ? ` and redirected to ${location}` : ""
        }.`
      )
    );
  }

  try {
    await expect(page).toHaveURL(/\/record$/, {
      timeout: protectedNavigationTimeout,
    });
  } catch (error) {
    const originalMessage =
      error instanceof Error ? error.message : String(error);

    throw new Error(
      await describeProtectedNavigationFailure(
        page,
        `/record responded successfully, but its navigation did not commit within ${protectedNavigationTimeout}ms. Original assertion: ${originalMessage}`
      )
    );
  }
}
