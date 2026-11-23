import { test, expect, type Page } from "@playwright/test";

async function workspace(page: Page, configured = true) {
  let name = "Shop Owner";
  let version = 1;
  const userId = "2199adf9-e493-49ab-9094-32e45782fb5d";
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/auth/me")
      return route.fulfill({
        json: {
          data: {
            id: userId,
            name,
            login: "owner",
            roles: ["OWNER"],
            permissions: ["access.manage"],
          },
        },
      });
    if (path === "/auth/csrf")
      return route.fulfill({ json: { data: { token: "account-csrf" } } });
    if (path === "/users")
      return route.fulfill({
        json: {
          data: [
            {
              id: userId,
              name,
              login: "owner",
              email: null,
              active: true,
              version,
              roles: [{ role: { code: "OWNER", name: "Owner" } }],
            },
          ],
        },
      });
    if (path === `/users/${userId}/profile`) {
      expect(route.request().postDataJSON()).toEqual({
        name: "Rahim",
        version: 1,
      });
      name = "Rahim";
      version++;
      return route.fulfill({ json: { data: { id: userId, name, version } } });
    }
    if (path === "/auth/account")
      return route.fulfill({
        json: { data: { email: null, mailConfigured: configured } },
      });
    if (path === "/auth/email/request-verification") {
      expect(route.request().postDataJSON()).toEqual({
        email: "arrahim.dev@gmail.com",
        currentPassword: "current-secret",
      });
      return route.fulfill({
        json: {
          data: {
            message: "Verification email sent. Open the link in your inbox.",
          },
        },
      });
    }
    if (path === "/auth/change-password") {
      const body = route.request().postDataJSON();
      if (body.currentPassword === "wrong")
        return route.fulfill({
          status: 400,
          json: { error: { message: "Current password is incorrect." } },
        });
      expect(body).toEqual({
        currentPassword: "current-secret",
        newPassword: "a-new-password-123",
      });
      return route.fulfill({ json: { data: { changed: true } } });
    }
    return route.fulfill({ json: { data: {} } });
  });
  await page.goto("/users");
  await page.getByRole("button", { name: "Edit Shop Owner" }).click();
}

test("users can edit their name and request verification for their Gmail", async ({
  page,
}, testInfo) => {
  await workspace(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Rahim");
  await dialog.getByRole("button", { name: "Save name" }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "Name updated." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Account menu", includeHidden: true }),
  ).toContainText("Rahim");
  await dialog.getByLabel("Email address").fill("arrahim.dev@gmail.com");
  await dialog
    .getByLabel("Password to confirm email change")
    .fill("current-secret");
  await dialog.getByRole("button", { name: "Send verification email" }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "Verification email sent." }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("Password to confirm email change"),
  ).toHaveValue("");
  await page.screenshot({ path: testInfo.outputPath("user-editor.png") });
  await dialog.getByRole("button", { name: "Close user editor" }).click();
  await expect(
    page.getByRole("cell", { name: "Rahim", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("cell", { name: "Rahim", exact: true }),
  ).toBeVisible();
});

test("changing passwords checks confirmation, preserves the session on a wrong password, and returns to login on success", async ({
  page,
}) => {
  await workspace(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Current password", { exact: true }).fill("wrong");
  await dialog
    .getByLabel("New password", { exact: true })
    .fill("a-new-password-123");
  await dialog.getByLabel("Confirm new password").fill("another-password-123");
  await dialog
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "New passwords do not match.",
  );
  await dialog.getByLabel("Confirm new password").fill("a-new-password-123");
  await dialog
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Current password is incorrect.",
  );
  await expect(page).toHaveURL(/\/users$/);
  await dialog
    .getByLabel("Current password", { exact: true })
    .fill("current-secret");
  await dialog
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page).toHaveURL(/\/login\?passwordChanged=1$/);
  await expect(page.getByRole("status")).toHaveText(
    "Password changed. Sign in with your new password.",
  );
  await expect(
    page.getByRole("link", { name: "Forgot password?" }),
  ).toBeVisible();
});

test("missing SMTP configuration is shown without claiming email has been sent", async ({
  page,
}) => {
  await workspace(page, false);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toContainText(
    "Email delivery needs to be enabled",
  );
  await expect(
    dialog.getByRole("button", { name: "Send verification email" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Change password", exact: true }),
  ).toBeEnabled();
});

test("forgot password, email confirmation, and reset forms submit through CSRF-protected requests", async ({
  page,
}) => {
  const token = "ab".repeat(32);
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/auth/csrf")
      return route.fulfill({ json: { data: { token: "public-csrf" } } });
    expect(route.request().headers()["x-csrf-token"]).toBe("public-csrf");
    if (path === "/auth/forgot-password") {
      expect(route.request().postDataJSON()).toEqual({
        email: "arrahim.dev@gmail.com",
      });
      return route.fulfill({
        json: {
          data: {
            message:
              "If this email is linked to an active account, a password reset link will be sent.",
          },
        },
      });
    }
    if (path === "/auth/email/verify") {
      expect(route.request().postDataJSON()).toEqual({ token });
      return route.fulfill({
        json: { data: { message: "Email verified. You can now sign in." } },
      });
    }
    if (path === "/auth/reset-password") {
      expect(route.request().postDataJSON()).toEqual({
        token,
        newPassword: "a-new-password-123",
      });
      return route.fulfill({
        json: {
          data: { message: "Password reset. Sign in with your new password." },
        },
      });
    }
    throw new Error(`Unexpected route: ${path}`);
  });
  await page.goto("/forgot-password");
  await page.getByLabel("Email address").fill("arrahim.dev@gmail.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText(
    "If this email is linked",
  );
  await page.goto(`/verify-email#token=${token}`);
  await page.getByRole("button", { name: "Verify email", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Email verified.");
  await expect(page).toHaveURL(/\/verify-email$/);
  await page.goto(`/reset-password#token=${token}`);
  await page
    .getByLabel("New password", { exact: true })
    .fill("a-new-password-123");
  await page.getByLabel("Confirm new password").fill("a-new-password-123");
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Password reset.");
  await expect(page).toHaveURL(/\/reset-password$/);
});
