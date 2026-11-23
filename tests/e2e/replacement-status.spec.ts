import { test, expect, type Route } from "@playwright/test";
import type {
  ReplacementCase,
  ReplacementStage,
} from "../../packages/api-client/src";

test("replacement rows save status, update summaries, retain failures and survive reload", async ({
  page,
}) => {
  let item: ReplacementCase = {
    id: "rep-1",
    number: "REP-001",
    status: "FAULTY",
    version: 1,
    product: "Test Battery",
    serial: "SER-100",
    customer: "Customer One",
    phone: "01700000000",
    invoice: "INV-001",
    supplier: "Supplier One",
    createdAt: "2026-11-16T12:00:00Z",
    sentAt: null,
  };
  let pending: Route | undefined;
  let fail = false;
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/auth/me"))
      return route.fulfill({
        json: {
          data: {
            id: "owner",
            name: "Owner",
            login: "owner",
            roles: ["OWNER"],
            permissions: [
              "dashboard.read",
              "replacements.intake.customer",
              "replacements.resolve",
              "replacements.dispatch",
              "replacements.receive",
              "replacements.deliver",
            ],
          },
        },
      });
    if (url.pathname.endsWith("/auth/csrf"))
      return route.fulfill({ json: { data: { token: "test" } } });
    if (url.pathname.includes("/modules/"))
      return route.fulfill({ json: { data: {} } });
    if (url.pathname.endsWith("/status")) {
      pending = route;
      if (fail) {
        pending = undefined;
        return route.fulfill({
          status: 503,
          json: { error: { message: "Could not save status" } },
        });
      }
      return;
    }
    if (url.pathname.endsWith("/replacements")) {
      const summary = { FAULTY: 0, SENT: 0, RECEIVED: 0, DELIVERED: 0 };
      summary[item.status] = 1;
      const status = url.searchParams.get("status");
      const items = status === "all" || status === item.status ? [item] : [];
      return route.fulfill({
        json: {
          data: { items, total: items.length, page: 1, pageSize: 10, summary },
        },
      });
    }
    return route.abort();
  });
  await page.goto("/replacements");
  const dropdown = page.getByRole("combobox", { name: "Status for REP-001" });
  await expect(dropdown).toHaveValue("FAULTY");
  const cards = page.locator(".replacement-stats .erp-stat");
  await expect(cards).toHaveCount(4);
  await expect(cards.locator(".erp-stat-caption")).toHaveCount(0);
  await expect(dropdown.locator("option")).toHaveText([
    "Faulty",
    "Sent",
    "Received",
    "Delivered",
  ]);
  const original = await cards.first().elementHandle();
  for (const status of [
    "SENT",
    "RECEIVED",
    "DELIVERED",
  ] as ReplacementStage[]) {
    await dropdown.selectOption(status);
    await expect.poll(() => Boolean(pending)).toBe(true);
    await expect(dropdown).toBeDisabled();
    expect(pending!.request().postDataJSON()).toEqual({
      status,
      version: item.version,
    });
    item = { ...item, status, version: item.version + 1 };
    await pending!.fulfill({
      json: { data: { id: item.id, status, version: item.version } },
    });
    pending = undefined;
    await expect(dropdown).toHaveValue(status);
    await expect(dropdown).toBeEnabled();
    const card = cards.filter({
      hasText:
        status === "SENT"
          ? "Sent"
          : status === "RECEIVED"
            ? "Received"
            : "Delivered",
    });
    await expect(card.locator(".erp-stat-value")).toHaveText("1");
  }
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
  fail = true;
  await dropdown.selectOption("FAULTY");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Could not save status",
  );
  await expect(dropdown).toHaveValue("DELIVERED");
  await expect(page.getByText("Replacement Details", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Details for REP-001" })).toHaveCount(0);
  await page.reload();
  await expect(dropdown).toHaveValue("DELIVERED");
  await page
    .getByRole("combobox", { name: "Record status" })
    .selectOption("FAULTY");
  await expect(dropdown).toHaveCount(0);
  await expect(page.getByText("No records to display")).toBeVisible();
});
