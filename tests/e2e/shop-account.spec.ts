import { test, expect } from "@playwright/test";

test("shop identity is displayed separately while keeping the same business name", async ({
  page,
}, testInfo) => {
  for (const branch of ["Betagi", "Mirzaganj"]) {
    await page.unroute("**/api/v1/**");
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        "/api/v1",
        "",
      );
      if (path === "/auth/me")
        return route.fulfill({
          json: {
            data: {
              id: `owner-${branch}`,
              name: "Shop Owner",
              login:
                branch === "Betagi"
                  ? "arrahim.dev@gmail.com"
                  : "rahim.mugnee@gmail.com",
              roles: ["OWNER"],
              permissions: ["settings.manage"],
              shop: {
                id: `shop-${branch}`,
                name: "Hawlader Battery House",
                branchName: branch,
              },
            },
          },
        });
      if (path === "/settings/shop")
        return route.fulfill({
          json: {
            data: {
              value: { name: "Hawlader Battery House", address: branch },
              version: 1,
            },
          },
        });
      if (path === "/shop-profile")
        return route.fulfill({
          json: { data: { name: "Hawlader Battery House", address: branch } },
        });
      return route.fulfill({ json: { data: {} } });
    });
    await page.goto("/settings");
    await page.reload();
    await expect(page.getByLabel("Shop name", { exact: true })).toHaveValue(
      "Hawlader Battery House",
    );
    await expect(page.getByLabel("Address", { exact: true })).toHaveValue(
      branch,
    );
    await expect(page.locator(".desktop-sidebar .brand")).toContainText(branch);
  }
  await page.screenshot({
    path: testInfo.outputPath("shop-identity.png"),
    fullPage: true,
  });
});

test("activation lets the invited shop owner choose their password and checks confirmation", async ({
  page,
}, testInfo) => {
  const token = "ab".repeat(32);
  let activated = false;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/auth/csrf")
      return route.fulfill({ json: { data: { token: "activation-csrf" } } });
    expect(path).toBe("/auth/activate-account");
    expect(route.request().headers()["x-csrf-token"]).toBe("activation-csrf");
    expect(route.request().postDataJSON()).toEqual({
      token,
      newPassword: "739152",
    });
    activated = true;
    return route.fulfill({
      json: {
        data: {
          message:
            "Account ready. Sign in with your email and the password you just chose.",
        },
      },
    });
  });
  await page.goto(`/activate-account#token=${token}`);
  await expect(
    page.getByRole("heading", { name: "Set up your shop account" }),
  ).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill("739152");
  await page.getByLabel("Confirm new password").fill("857614");
  await page
    .getByRole("button", { name: "Activate account", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Passwords do not match." }),
  ).toBeVisible();
  expect(activated).toBe(false);
  await page.getByLabel("Confirm new password").fill("739152");
  await page.screenshot({
    path: testInfo.outputPath("shop-activation.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Activate account", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Account ready.");
  await expect(page).toHaveURL(/\/activate-account$/);
});
