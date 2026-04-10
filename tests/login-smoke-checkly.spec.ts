/**
 * DRMS — Login Page Smoke Test
 * Paste this script into the Checkly UI when creating a Browser Check.
 *
 * Set ENVIRONMENT_URL as a Checkly environment variable to target a specific
 * deployment (e.g. https://drms.sonatech.ac.in). Falls back to the staging URL.
 */
import { expect, test } from '@playwright/test';

const BASE_URL =
  process.env.ENVIRONMENT_URL || 'https://staging.example.com';

test('DRMS login page loads with auth form intact', async ({ page }) => {
  await page.goto(`${BASE_URL}/login`);

  // Page title served correctly
  await expect(page).toHaveTitle(/DRMS/i);

  // "Welcome Back" heading rendered by AuthSplitLayout
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();

  // Email and password inputs are present and interactive
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeEnabled();

  // Sign In button is present and not disabled on initial load
  await expect(page.getByRole('button', { name: /sign in/i })).toBeEnabled();

  // Forgot Password link is present
  await expect(page.getByRole('link', { name: /forgot password/i })).toBeVisible();
});
