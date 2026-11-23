import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// Exercise the actual release bridge. Expo web preview doesn't serialize props
// and cannot catch request loops caused by native object identity changes.
const folder = process.argv[2];
if (!folder) throw new Error("Pass the exported www.bundle directory.");
const html = fs.readdirSync(folder).filter((name) => name.endsWith(".html"));
assert.equal(html.length, 1, "Use a clean release export with one DOM bundle.");
const browser = await chromium.launch({
  channel: process.platform === "win32" ? "chrome" : undefined,
  args: ["--allow-file-access-from-files"],
});
try {
  const page = await browser.newPage({ viewport: { width: 393, height: 780 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/^https?:/, (route) => {
    errors.push("Unexpected remote request");
    return route.abort();
  });
  await page.addInitScript(() => {
    const user = {
      id: "test-owner",
      name: "Test Owner",
      login: "owner",
      roles: ["OWNER"],
      permissions: [
        "dashboard.read",
        "inventory.read",
        "sales.manage",
        "finance.read",
      ],
      shop: { id: "test-shop", name: "Test Shop" },
    };
    const props = {
      pathname: "/dashboard",
      nativeViewport: true,
      user,
      origin: "https://erp.test",
      pending: 0,
      blocked: 0,
      offline: false,
      syncing: false,
      syncError: "",
      lastSync: null,
    };
    const names = ["onRequest", "onNavigate", "onOriginChange"];
    const reads = [];
    const update = (change) => {
      Object.assign(props, change);
      window.dispatchEvent(
        new CustomEvent("$$dom_event", {
          detail: {
            type: "$$props",
            data: JSON.parse(JSON.stringify({ names, props })),
          },
        }),
      );
    };
    window.nativeTest = { reads, update, props };
    const type = {
      id: "battery",
      name: "Battery",
      trackingKind: "BATTERY_UNIT",
    };
    const options = {
      types: [type],
      products: [
        {
          id: "product",
          name: "Battery A",
          model: "M",
          unit: "piece",
          type,
          defaultSellingPrice: "150.00",
          availableQuantity: "12",
        },
      ],
      customers: [
        { id: "customer", name: "Test Customer", phone: "01700000001" },
      ],
      paymentAccounts: [{ id: "cash", name: "Cash", paymentMethod: "CASH" }],
    };
    const dashboard = {
      counts: {},
      financials: {},
      recentSales: [],
      lowStock: [],
      salesTrend: [],
    };
    window.ReactNativeWebView = {
      injectedObjectJson: () =>
        JSON.stringify({
          EXPO_DOM_HOST_OS: "android",
          initialProps: { names, props },
        }),
      postMessage: (raw) => {
        const message = JSON.parse(raw);
        if (message.type !== "$$native_action") return;
        const request = message.data.args[0];
        if (message.data.actionId === "onNavigate") {
          update({ pathname: request });
        }
        const route = request?.route;
        if (route) {
          reads.push(route);
          // Each native read used to publish status, marshaling the account again.
          if (reads.length < 100) setTimeout(() => update({}), 5);
        }
        const data = route?.startsWith("/dashboard")
          ? dashboard
          : route === "/sales/options"
            ? options
            : route === "/shop-profile"
              ? { name: "Test Shop" }
              : route?.startsWith("/modules/")
                ? { status: "active" }
                : { types: [type], categories: [], items: [], total: 0 };
        const delay = route === "/sales/options" ? 150 : 0;
        setTimeout(
          () =>
            window.dispatchEvent(
              new CustomEvent("$$dom_event", {
                detail: {
                  type: "$$native_action_result",
                  data: {
                    uid: message.data.uid,
                    actionId: message.data.actionId,
                    result: { ok: true, data },
                  },
                },
              }),
            ),
          delay,
        );
      },
    };
  });
  await page.goto(pathToFileURL(path.resolve(folder, html[0])).href);
  await expect(page.locator(".dashboard-intro")).toContainText("Test Owner");
  await page.waitForTimeout(1000);
  const initialReads = await page.evaluate(
    () => window.nativeTest.reads.length,
  );
  assert.equal(
    initialReads,
    4,
    "Status updates must not repeatedly fetch account resources.",
  );
  await page.evaluate(() =>
    window.nativeTest.update({
      user: { ...window.nativeTest.props.user, name: "Updated Owner" },
    }),
  );
  await expect(page.locator(".dashboard-intro")).toContainText("Updated Owner");
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(() => window.nativeTest.reads.length),
    7,
    "Real account changes must revalidate resources once.",
  );
  await page.evaluate(() => window.nativeTest.update({ pathname: "/sales" }));
  await page.getByLabel("Select customer").selectOption("customer");
  await page.getByLabel("Sales product category").selectOption("battery");
  await page
    .getByLabel("Sales product", { exact: true })
    .selectOption("product");
  await page.getByLabel("Sales quantity").fill("2");
  await page.evaluate(() => {
    window.formNode = document.querySelector('[aria-label="Sales quantity"]');
    window.nativeTest.update({ lastSync: "2026-11-21T12:00:00Z" });
  });
  await expect(page.getByLabel("Select customer")).toHaveValue("customer");
  await expect(page.getByLabel("Sales product", { exact: true })).toHaveValue(
    "product",
  );
  await expect(page.getByLabel("Sales quantity")).toHaveValue("2");
  assert(
    await page.evaluate(
      () =>
        window.formNode ===
        document.querySelector('[aria-label="Sales quantity"]'),
    ),
    "Background refresh must not replace the form.",
  );
  await page.waitForTimeout(500);
  assert.equal(
    await page.evaluate(
      () =>
        window.nativeTest.reads.filter((route) => route === "/sales/options")
          .length,
    ),
    2,
  );
  assert.deepEqual(errors, []);
  await expect(page.locator(".top-header .header-pending-count")).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(
    page.getByRole("menuitem", { name: "0 pending transactions", exact: true }),
  ).toBeVisible();
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await page.evaluate(() =>
    window.nativeTest.update({ syncing: true, transferring: false }),
  );
  await expect(page.locator(".top-header [role=status]")).toHaveCount(0);
  await page.evaluate(() =>
    window.nativeTest.update({
      syncing: false,
      lastSync: "2026-11-23T00:00:00Z",
    }),
  );
  await page.clock.runFor(1);
  await expect(page.locator(".top-header [role=status]")).toHaveCount(0);
  await page.evaluate(() =>
    window.nativeTest.update({ syncing: true, transferring: true, pending: 2 }),
  );
  await expect(
    page.getByRole("menuitem", { name: "2 pending transactions", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".top-header [role=status]")).toHaveText(
    "Syncing…",
  );
  await page.evaluate(() =>
    window.nativeTest.update({
      syncing: false,
      transferring: false,
      pending: 0,
      lastSync: "2026-11-24T00:00:00Z",
    }),
  );
  await page.clock.runFor(1);
  await expect(page.locator(".top-header [role=status]")).toBeVisible();
  await expect(page.locator(".top-header [role=status]")).toHaveText("Synced");
  await page.clock.runFor(2998);
  await expect(page.locator(".top-header [role=status]")).toBeVisible();
  await page.clock.runFor(3);
  await expect(page.locator(".top-header [role=status]")).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "0 pending transactions", exact: true }),
  ).toBeVisible();
  console.log(
    "Release native bridge passed: no request loop, account updates apply, sales draft survives background sync.",
  );
} finally {
  await browser.close();
}
