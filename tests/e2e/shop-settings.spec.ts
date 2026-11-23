import { test, expect } from "@playwright/test";

test("shop profile is editable, saved, and reflected in the sidebar after reload", async ({
  page,
}, testInfo) => {
  let shop = {
    value: {
      name: "Original Battery",
      address: "",
      phone: "",
      currency: "BDT",
      timezone: "Asia/Dhaka",
    },
    version: 1,
  };
  let failSave = false;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/auth/me")
      return route.fulfill({
        json: {
          data: {
            id: "settings-owner",
            name: "Shop Owner",
            login: "owner",
            roles: ["OWNER"],
            permissions: ["settings.manage", "dashboard.read"],
          },
        },
      });
    if (path === "/auth/csrf")
      return route.fulfill({ json: { data: { token: "settings-csrf" } } });
    if (path === "/settings/shop") {
      if (route.request().method() === "POST") {
        if (failSave)
          return route.fulfill({
            status: 500,
            json: { error: { message: "Unable to save shop profile." } },
          });
        const body = route.request().postDataJSON();
        expect(body).toEqual({
          name: "New Battery House",
          address: "Dhaka, Bangladesh",
          phone: "01712345678",
          version: 1,
        });
        expect(route.request().headers()["x-csrf-token"]).toBe("settings-csrf");
        shop = {
          value: {
            ...shop.value,
            name: body.name,
            address: body.address,
            phone: body.phone,
          },
          version: 2,
        };
      }
      return route.fulfill({ json: { data: shop } });
    }
    if (path === "/shop-profile")
      return route.fulfill({ json: { data: shop.value } });
    return route.fulfill({ json: { data: {} } });
  });
  await page.goto("/settings");
  await expect(page.getByLabel("Shop name", { exact: true })).toHaveValue(
    "Original Battery",
  );
  await expect(page.getByText("Currency", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Business timezone", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Read only", { exact: true })).toHaveCount(0);
  await page.getByLabel("Shop name", { exact: true }).fill("New Battery House");
  await page.getByLabel("Address", { exact: true }).fill("Dhaka, Bangladesh");
  await page.getByLabel("Phone", { exact: true }).fill("01712345678");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toHaveText("Shop profile saved.");
  await expect(
    page
      .getByRole("link", {
        name: "New Battery House dashboard",
        includeHidden: true,
      })
      .first(),
  ).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel("Shop name", { exact: true })).toHaveValue(
    "New Battery House",
  );
  await expect(page.getByLabel("Address", { exact: true })).toHaveValue(
    "Dhaka, Bangladesh",
  );
  await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
    "01712345678",
  );
  await expect(page.locator(".desktop-sidebar .shop-card")).toContainText(
    "New Battery House",
  );
  await expect(page.locator(".desktop-sidebar .shop-card")).toContainText(
    "Dhaka, Bangladesh",
  );
  await expect(page.locator(".desktop-sidebar .shop-card")).toContainText(
    "01712345678",
  );
  await page.screenshot({
    path: testInfo.outputPath("shop-settings.png"),
    fullPage: true,
  });
  failSave = true;
  await page.getByLabel("Shop name", { exact: true }).fill("Unsaved name");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Unable to save shop profile." }),
  ).toHaveText("Unable to save shop profile.");
  await expect(page.getByLabel("Shop name", { exact: true })).toHaveValue(
    "Unsaved name",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
