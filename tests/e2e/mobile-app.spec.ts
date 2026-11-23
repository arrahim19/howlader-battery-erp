import { test, expect, type Page } from "@playwright/test";
import { openApp, ids, appURL } from "./fixtures/mobile";

test("native host stays mounted through login, navigation and logout", async ({
  page,
}) => {
  await openApp(page, false, undefined, async () => {
    await page.evaluate(() => {
      (window as unknown as { nativeHost: Element | null }).nativeHost =
        document.querySelector(".mobile-auth")!.parentElement;
    });
  });
  const hostConnected = () =>
    page.evaluate(() =>
      Boolean(
        (window as unknown as { nativeHost: Element | null }).nativeHost
          ?.isConnected,
      ),
    );
  expect(await hostConnected()).toBe(true);
  await page
    .getByRole("navigation", { name: "Quick access" })
    .getByRole("link", { name: "Inventory", exact: true })
    .click();
  await expect(page.locator(".top-header h1")).toHaveText("Inventory / Stock");
  expect(await hostConnected()).toBe(true);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in to workspace", exact: true }),
  ).toBeVisible();
  expect(await hostConnected()).toBe(true);
});

test("email login validates fields and shows server errors without Google", async ({
  page,
}) => {
  await page.goto(`${appURL}/login`);
  await page
    .getByRole("button", { name: "Sign in to workspace", exact: true })
    .click();
  await expect(
    page.getByText("Enter your login.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Enter your password.", { exact: true }),
  ).toBeVisible();
  await page.getByText("Server connection", { exact: true }).click();
  await page
    .getByLabel("Website address", { exact: true })
    .fill("https://erp.test");
  await page.route("**/api/v1/auth/mobile/login", (route) =>
    route.fulfill({
      status: route.request().method() === "OPTIONS" ? 200 : 401,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
      },
      json: { error: { message: "Invalid email or password." } },
    }),
  );
  await page
    .getByLabel("Email or login", { exact: true })
    .fill("owner@example.com");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page
    .getByRole("button", { name: "Show password", exact: true })
    .click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await page
    .getByRole("button", { name: "Sign in to workspace", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "Invalid email or password.",
  );
  await expect(page.getByRole("link", { name: /Google/ })).toHaveCount(0);
  for (const path of ["/google-sign-in", "/device"]) {
    await page.goto(appURL + path);
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByLabel("Email or login", { exact: true }),
    ).toBeVisible();
  }
});

test("native login matches browser mobile layout and stays usable on short screens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 780 });
  await page.goto(`${appURL}/login`);
  await expect(
    page.getByRole("heading", { name: "Good to see you again." }),
  ).toBeVisible();
  const browser = await page.context().newPage();
  await browser.setViewportSize({ width: 393, height: 780 });
  await browser.goto("http://localhost:3000/login");
  await expect(
    browser.getByRole("heading", { name: "Good to see you again." }),
  ).toBeVisible();
  const measure = (target: Page) =>
    target.evaluate(async () => {
      await document.fonts.ready;
      return ["main", "h2", "#login", "#password", "button[type=submit]"].map(
        (selector) => {
          const node = document.querySelector(selector)!;
          const rect = node.getBoundingClientRect();
          return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            font: getComputedStyle(node).fontSize,
          };
        },
      );
    });
  // The APK's DOM surface places React content directly inside a flex-row root.
  // Remove only Expo web's extra native-renderer wrappers to exercise that host.
  await page.evaluate(() => {
    const auth = document.querySelector(".mobile-auth")!;
    for (
      let node = auth.parentElement;
      node && node.id !== "root";
      node = node.parentElement
    ) {
      node.style.display = "contents";
    }
    document.documentElement.setAttribute("data-native-workspace", "");
  });
  const nativeMeasurements = await measure(page),
    browserMeasurements = await measure(browser);
  for (let index = 0; index < nativeMeasurements.length; index++) {
    const native = nativeMeasurements[index],
      web = browserMeasurements[index];
    expect({ ...native, y: 0 }).toEqual({ ...web, y: 0 });
    expect(Math.abs(native.y - web.y)).toBeLessThanOrEqual(2);
  }
  await browser.close();
  for (const size of [
    { width: 320, height: 568 },
    { width: 393, height: 420 },
    { width: 780, height: 360 },
  ]) {
    await page.setViewportSize(size);
    await expect(
      page.getByLabel("Email or login", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Email or login", { exact: true })
      .fill("test@example.com");
    await page.getByLabel("Password", { exact: true }).fill("123456");
    await page
      .getByRole("button", { name: "Sign in to workspace" })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("button", { name: "Sign in to workspace" }),
    ).toBeInViewport();
    await page.getByText("Server connection", { exact: true }).click();
    await page.getByLabel("Website address").fill("https://erp.example.com");
    await expect(page.getByLabel("Website address")).toBeInViewport();
    expect(
      await page
        .locator(".mobile-auth")
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await page.getByText("Server connection", { exact: true }).click();
  }
});

test("native quick access stays at the usable screen bottom at different heights", async ({
  page,
}) => {
  await openApp(page, false);
  for (const height of [640, 780, 900]) {
    await page.setViewportSize({ width: 393, height });
    for (const inset of [0, 24, 48]) {
      await page.evaluate((reserved) => {
        document.documentElement.setAttribute("data-native-workspace", "");
        document.documentElement.style.height = `calc(100% - ${reserved}px)`;
      }, inset);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const body = document
              .querySelector(".app-body")!
              .getBoundingClientRect();
            const nav = document
              .querySelector(".mobile-quick-access")!
              .getBoundingClientRect();
            return {
              bottom: Math.round(body.bottom),
              gap: Math.round(body.bottom - nav.bottom),
            };
          }),
        )
        .toEqual({ bottom: height - inset, gap: 5 });
      await expect(page.locator(".top-header")).toBeInViewport();
      await expect(
        page.getByRole("link", { name: "Dashboard", exact: true }).last(),
      ).toBeInViewport();
    }
  }
});

test("app uses the shared browser mobile UI and navigation", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixtures = new Map<string, unknown>();
  await openApp(page, true, (path, data) => fixtures.set(path, data));
  const nav = page.getByRole("navigation", { name: "Quick access" });
  await expect(nav.getByRole("link")).toHaveText([
    "Inventory",
    "Purchase",
    "Sales",
    "Customer",
    "Dashboard",
  ]);
  await expect(page.locator(".dashboard-page .erp-stats")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("shared-dashboard.png") });
  const browser = await page.context().newPage();
  await browser.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    return route.fulfill({
      json: { data: fixtures.get(path) ?? { types: [], categories: [] } },
    });
  });
  await browser.goto("http://localhost:3000/dashboard");
  await expect(browser.locator(".dashboard-intro")).toContainText(
    "Rahim Mugnee",
  );
  await browser.screenshot({
    path: testInfo.outputPath("chrome-mobile-dashboard.png"),
  });
  const metrics = (target: Page) =>
    target.evaluate(async () => {
      await document.fonts.ready;
      return [
        ".top-header",
        ".date-pills",
        ".erp-stats",
        ".mobile-quick-access",
      ].map((selector) => {
        const node = document.querySelector(selector)!;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          selector,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          fontSize: style.fontSize,
          borderRadius: style.borderRadius,
        };
      });
    });
  expect(await metrics(page)).toEqual(await metrics(browser));
  await browser.close();
  await page
    .locator(".top-header")
    .evaluate((node) => node.setAttribute("data-persistent-shell", "original"));
  await page
    .locator(".mobile-quick-access")
    .evaluate((node) => node.setAttribute("data-persistent-nav", "original"));
  await nav.getByRole("link", { name: "Inventory", exact: true }).click();
  await expect(
    page.getByText("Battery A", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator(".top-header")).toHaveAttribute(
    "data-persistent-shell",
    "original",
  );
  await expect(page.locator(".mobile-quick-access")).toHaveAttribute(
    "data-persistent-nav",
    "original",
  );
  await page.screenshot({ path: testInfo.outputPath("shared-inventory.png") });
  await page.goBack();
  await expect(page.locator(".dashboard-intro")).toContainText("Rahim Mugnee");
  await expect(page.locator(".top-header")).toHaveAttribute(
    "data-persistent-shell",
    "original",
  );
  expect(errors).toEqual([]);
});

test("shared mobile inventory remains readable offline", async ({ page }) => {
  await openApp(page);
  const nav = page.getByRole("navigation", { name: "Quick access" });
  await nav.getByRole("link", { name: "Inventory", exact: true }).click();
  await expect(
    page.getByText("Battery A", { exact: true }).first(),
  ).toBeVisible();
  const disconnected = (route: import("@playwright/test").Route) =>
    route.abort("internetdisconnected");
  await page.route("**/api/v1/**", disconnected);
  await page.context().setOffline(true);
  await nav.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.locator(".dashboard-intro")).toContainText("Rahim Mugnee");
  await nav.getByRole("link", { name: "Inventory", exact: true }).click();
  await expect(
    page.getByText("Battery A", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Offline/ })).toBeVisible();
});

test("shared sales form uses the local transaction bridge", async ({
  page,
}, testInfo) => {
  const requests = await openApp(page);
  await page.getByRole("link", { name: "New Sale", exact: true }).click();
  await expect(page.getByLabel("Select customer")).toBeVisible();
  await page.getByLabel("Select customer").selectOption(ids.customer);
  await page.getByLabel("Sales product category").selectOption("battery");
  await page
    .getByLabel("Sales product", { exact: true })
    .selectOption(ids.product);
  await page.getByLabel("Sales quantity").fill("2");
  await page.getByRole("button", { name: "Payment", exact: true }).click();
  await page.getByLabel("Sales type").selectOption("partial");
  await page.getByLabel("Sales paid amount").fill("100.00");
  await page.screenshot({ path: testInfo.outputPath("shared-sale.png") });
  await page.getByRole("button", { name: "Confirm Sale", exact: true }).click();
  await expect(page.getByLabel("Sales quantity")).toHaveValue("0");
  await expect(page.locator(".sales-success")).toHaveCount(0);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: /pending transactions/ }).click();
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(
    page.getByText("All saved transactions have reached the server.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1].key).toBe(requests[0].key);
  expect(requests[1].body).toMatchObject({
    customerId: ids.customer,
    items: [{ productId: ids.product, quantity: 2, unitPrice: "150.00" }],
    paidAmount: "100.00",
    paymentAccountId: ids.account,
  });
});

test("a device with internet disabled saves a sale locally and immediately updates stock", async ({
  page,
}) => {
  const requests = await openApp(page, false);
  await page.context().setOffline(true);
  await page.getByRole("link", { name: "New Sale", exact: true }).click();
  await page.getByLabel("Select customer").selectOption(ids.customer);
  await page.getByLabel("Sales product category").selectOption("battery");
  await page
    .getByLabel("Sales product", { exact: true })
    .selectOption(ids.product);
  await page.getByLabel("Sales quantity").fill("2");
  await page.getByRole("button", { name: "Confirm Sale", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "ডিভাইসে বিক্রয় সেভ হয়েছে" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: "Quick access" });
  await nav.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByText(/This page has not been downloaded/)).toHaveCount(
    0,
  );
  await nav.getByRole("link", { name: "Inventory", exact: true }).click();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText("Battery A", { exact: true }) });
  await expect(row.getByText("10", { exact: true }).first()).toBeVisible();
  expect(requests).toHaveLength(0);
});
