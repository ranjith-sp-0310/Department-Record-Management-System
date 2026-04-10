/**
 * DRMS — Login Page Smoke Test
 * Paste this script into the Checkly UI when creating a Browser Check.
 *
 * Set ENVIRONMENT_URL as a Checkly environment variable to target a specific
 * deployment (e.g. https://drms.sonatech.ac.in). Falls back to the staging URL.
 *
 * What this proves:
 *   1. Frontend is reachable and renders correctly (static hosting / CDN works)
 *   2. Backend API is reachable and responds (not just a frontend-up check)
 *   3. Auth error handling works end-to-end
 */
import { expect, test } from '@playwright/test';

const BASE_URL =
  process.env.ENVIRONMENT_URL || 'https://staging.example.com';

test('DRMS login page — frontend up, API reachable, auth error returned', async ({ page }) => {
  // ── 1. Load the login page ─────────────────────────────────────────────
  await page.goto(`${BASE_URL}/login`);

  await expect(page).toHaveTitle(/DRMS/i);
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeEnabled();

  // ── 2. Submit invalid credentials and intercept the API call ──────────
  // Intercept the POST /auth/login response.
  // A 401 back from the server means the API is reachable and auth works.
  // A network error (status 0) means the backend is down or misconfigured.
  const [apiResponse] = await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().includes('/auth/login') && resp.request().method() === 'POST',
      { timeout: 15_000 }
    ),
    (async () => {
      await page.locator('input[name="email"]').fill('smoke-test-invalid@checkly.invalid');
      await page.locator('input[name="password"]').fill('this-is-not-a-real-password');
      await page.getByRole('button', { name: /sign in/i }).click();
    })(),
  ]);

  // ── 3. Assert backend responded (any HTTP status beats a network error) ─
  // 401 = invalid credentials (expected) ✓
  // 400 = validation error (still means API is up) ✓
  // 0 or timeout = backend unreachable ✗
  const status = apiResponse.status();
  expect(
    status,
    `Expected a 4xx from the login API (got ${status}). ` +
    `Status 0 means the backend is not reachable from the Checkly runner.`
  ).toBeGreaterThanOrEqual(400);
  expect(status).toBeLessThan(500);

  // ── 4. Confirm the UI surfaced an error message (not a blank or crashed page) ─
  // The ErrorMessage component renders the server's error text into the DOM.
  // We don't assert exact wording — any visible error text is fine.
  await expect(
    page.locator('text=/invalid|incorrect|not found|failed|wrong|error/i').first()
  ).toBeVisible({ timeout: 5_000 });
});
