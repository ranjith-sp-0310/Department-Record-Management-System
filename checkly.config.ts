import { defineConfig } from 'checkly';
import { EmailAlertChannel, Frequency } from 'checkly/constructs';

// ── Alert channels ────────────────────────────────────────────────────────────
// Two email recipients receive failure and recovery notifications.
// sendDegraded is off to reduce noise for slow-but-passing checks.

const emailAlertDrmsit = new EmailAlertChannel('alert-drmsit-sonatech', {
  address: 'drmsit@sonatech.ac.in',
  sendFailure: true,
  sendRecovery: true,
  sendDegraded: false,
});

const emailAlertRanjith = new EmailAlertChannel('alert-ranjithrk-gmail', {
  address: 'ranjithrk0310@gmail.com',
  sendFailure: true,
  sendRecovery: true,
  sendDegraded: false,
});

// ── Checkly project config ────────────────────────────────────────────────────
export default defineConfig({
  projectName: 'Department Record Management System',
  logicalId: 'drms-checkly-project',
  repoUrl: 'https://github.com/ranjith-sp-0310/department-record-management-system',

  checks: {
    // Point to the existing Playwright config — no new config is created.
    playwrightConfigPath: './playwright.config.ts',

    // Monitor from two locations for geographic redundancy.
    locations: ['eu-west-1', 'us-east-1'],

    // Both alert channels receive every check's failure/recovery events.
    alertChannels: [emailAlertDrmsit, emailAlertRanjith],

    playwrightChecks: [
      {
        // Critical happy-path: login page loads with all auth form elements.
        // Selected via the 'checkly' project defined in playwright.config.ts.
        // Runs the entire tests/ directory filtered to the 'checkly' project.
        name: 'Login Page Smoke Test',
        logicalId: 'login-page-smoke',
        pwProjects: ['checkly'],
        frequency: Frequency.EVERY_10M,
      },
    ],
  },

  cli: {
    // Use eu-west-1 as the local validation location when running `checkly test`.
    runLocation: 'eu-west-1',
    // No retries during local/CI validation runs — keep feedback fast.
    retries: 0,
  },
});
