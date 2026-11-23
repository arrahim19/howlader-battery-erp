import { test, expect } from "@playwright/test";

test("replacement list scrolls through every record without pagination and keeps an 8px bottom gap", async ({
  page,
}) => {
  const requestedPages = new Set<number>();
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
            permissions: ["dashboard.read", "replacements.resolve"],
          },
        },
      });
    if (url.pathname.includes("/modules/"))
      return route.fulfill({ json: { data: {} } });
    if (url.pathname.endsWith("/replacements")) {
      const currentPage = Number(url.searchParams.get("page"));
      expect(url.searchParams.get("pageSize")).toBe("100");
      requestedPages.add(currentPage);
      const filtered = Boolean(url.searchParams.get("q"));
      const total = filtered ? 1 : 205;
      const items = Array.from(
        { length: Math.max(0, Math.min(100, total - (currentPage - 1) * 100)) },
        (_, index) => {
          const row = (currentPage - 1) * 100 + index + 1;
          return {
            id: `rep-${row}`,
            number: `REP-${row}`,
            status: "FAULTY",
            version: 1,
            product: `Battery ${row}`,
            serial: `BAT-${row}`,
            customer: null,
            phone: null,
            invoice: null,
            supplier: "Supplier",
            createdAt: "2026-11-20T00:00:00Z",
            sentAt: null,
          };
        },
      );
      return route.fulfill({
        json: {
          data: {
            items,
            total,
            page: currentPage,
            pageSize: 100,
            summary: { FAULTY: total, SENT: 0, RECEIVED: 0, DELIVERED: 0 },
          },
        },
      });
    }
    return route.abort();
  });
  await page.goto("/replacements/list");
  const panel = page.locator(".replacement-list-panel");
  await expect(panel.locator("tbody tr")).toHaveCount(205);
  expect([...requestedPages]).toEqual([1, 2, 3]);
  await expect(
    page.getByRole("combobox", { name: "Rows per page" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^(Previous|Next)$/ }),
  ).toHaveCount(0);
  const scroll = panel.locator(".erp-table-wrap");
  expect(
    await scroll.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    panel.getByRole("cell", { name: "Battery 205", exact: true }),
  ).toBeInViewport();
  const layout = await panel.evaluate((element) => {
    const nav = document.querySelector(".mobile-quick-access")!;
    const bottom =
      getComputedStyle(nav).display === "none"
        ? innerHeight
        : nav.getBoundingClientRect().top;
    return {
      gap: bottom - element.getBoundingClientRect().bottom,
      documentScroll: document.documentElement.scrollHeight > innerHeight,
    };
  });
  expect(layout.gap).toBe(8);
  expect(layout.documentScroll).toBe(false);
  await page.getByLabel("Search replacements").fill("filtered");
  await expect(panel.locator("tbody tr")).toHaveCount(1);
  await expect(
    panel.getByRole("cell", { name: "Battery 205", exact: true }),
  ).toHaveCount(0);
});
