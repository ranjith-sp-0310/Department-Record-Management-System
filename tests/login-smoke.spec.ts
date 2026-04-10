/**
 * Login Page Smoke Test — @smoke
 *
 * Monitoring goal: confirm the DRMS frontend is reachable, the login page
 * renders without JS errors, and the critical authentication form is intact.
 *
 * This test intentionally does NOT attempt a full login+OTP flow so it stays
 * fast (<10 s) and free of credential/email-delivery flakiness.
 * It is selected for Checkly via `pwProjects: ['checkly']` in checkly.config.ts.
 */
import { test, expect } from '@playwright/test';

test.describe('Login page @smoke', () => {
  test('login page loads with correct title and auth form', async ({ page }) => {
    // Navigate to the login route.
    // baseURL is resolved from playwright.config.ts based on CHECKLY env var.
    await page.goto('/login');

    // ── Page-level checks ─────────────────────────────────────────────────
    // Verify the HTML document title is served correctly.
    await expect(page).toHaveTitle(/DRMS/i);

    // ── Auth form checks ──────────────────────────────────────────────────
    // Verify the "Welcome Back" heading rendered by AuthSplitLayout.
    await expect(
      page.getByRole('heading', { name: /welcome back/i })
    ).toBeVisible();

    // Verify the email input field is present and interactive.
    const emailInput = page.locator('input[name="email"]');
    await expect(emailInput).toBeVisible();
    await expect(emailInput).toBeEnabled();

    // Verify the password input field is present and interactive.
    const passwordInput = page.locator('input[name="password"]');
    await expect(passwordInput).toBeVisible();
    await expect(passwordInput).toBeEnabled();

    // Verify the Sign In submit button is present and not disabled on initial load.
    const signInButton = page.getByRole('button', { name: /sign in/i });
    await expect(signInButton).toBeVisible();
    await expect(signInButton).toBeEnabled();

    // Verify the Forgot Password link is present.
    await expect(page.getByRole('link', { name: /forgot password/i })).toBeVisible();
  });
});
