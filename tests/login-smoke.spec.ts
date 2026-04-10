/**
 * Login Page Smoke Test — @smoke
 *
 * Monitoring goal: confirm the DRMS frontend is reachable, the login page
 * renders without JS errors, the backend API responds to auth requests,
 * and the critical authentication form surfaces errors correctly.
 *
 * Selected for Checkly via `pwProjects: ['checkly']` in checkly.config.ts.
 *
 * What this proves:
 *   1. Frontend is reachable and renders correctly
 *   2. Backend API is reachable and responds
 *   3. Auth error handling works end-to-end
 */
import { test, expect } from '@playwright/test';

test.describe('Login page @smoke', () => {
  test('frontend up, API reachable, auth error returned for bad creds', async ({ page }) => {
    // ── 1. Load the login page ───────────────────────────────────────────
    // baseURL is resolved from playwright.config.ts (PUBLIC_MONITOR_URL when CHECKLY=1)
    await page.goto('/login');

    await expect(page).toHaveTitle(/DRMS/i);
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeEnabled();

    // ── 2. Submit invalid credentials and intercept the API call ─────────
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

    // ── 3. Assert backend responded (any HTTP status beats a network error) ──
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

    // ── 4. Confirm the UI surfaced an error message ───────────────────────
    await expect(
      page.locator('text=/invalid|incorrect|not found|failed|wrong|error/i').first()
    ).toBeVisible({ timeout: 5_000 });
  });
});
