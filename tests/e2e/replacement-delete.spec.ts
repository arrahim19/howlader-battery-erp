import { test, expect } from "@playwright/test";

for (const source of ["BEFORE_SALE", "CUSTOMER_WARRANTY"]) {
  test(`replacement delete confirms and refreshes the list (${source})`, async ({
    page,
  }) => {
    let deleted = false;
    let fail = true;
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/auth/me"))
        return route.fulfill({
          json: {
            data: {
              id: "owner",
              name: "Owner",
              login: "owner",
              roles: ["OWNER"],
              permissions: [
                "dashboard.read",
                "transactions.reverse",
                "replacements.resolve",
              ],
            },
          },
        });
      if (path.endsWith("/auth/csrf"))
        return route.fulfill({ json: { data: { token: "test" } } });
      if (path.includes("/modules/"))
        return route.fulfill({ json: { data: {} } });
      if (
        path.endsWith("/replacements/rep-1") &&
        route.request().method() === "DELETE"
      ) {
        expect(route.request().postDataJSON()).toEqual({
          confirmed: true,
          version: 1,
        });
        if (fail)
          return route.fulfill({
            status: 409,
            json: { error: { message: "Battery changed" } },
          });
        deleted = true;
        return route.fulfill({
          json: { data: { id: "rep-1", deleted: true } },
        });
      }
      if (path.endsWith("/replacements"))
        return route.fulfill({
          json: {
            data: {
              items: deleted
                ? []
                : [
                    {
                      id: "rep-1",
                      source,
                      number: "REP-001",
                      status: "FAULTY",
                      version: 1,
                      product: "Test Battery",
                      serial: "BAT-1",
                      customer: source === "BEFORE_SALE" ? null : "Customer",
                      phone: null,
                      invoice: source === "BEFORE_SALE" ? null : "INV-1",
                      supplier: "Supplier",
                      createdAt: "2026-11-20T00:00:00Z",
                      sentAt: null,
                    },
                  ],
              total: deleted ? 0 : 1,
              page: 1,
              pageSize: 10,
              summary: {
                FAULTY: deleted ? 0 : 1,
                SENT: 0,
                RECEIVED: 0,
                DELIVERED: 0,
              },
            },
          },
        });
      return route.abort();
    });
    await page.goto("/replacements/list");
    const trigger = page.getByRole("button", {
      name: "Delete replacement REP-001",
    });
    await trigger.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(
      source === "BEFORE_SALE" ? "আগের stock অবস্থায়" : "আগের customer অবস্থায়",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(deleted).toBe(false);
    await trigger.click();
    await dialog
      .getByRole("button", { name: "Delete Replacement", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toHaveText("Battery changed");
    expect(deleted).toBe(false);
    fail = false;
    await dialog
      .getByRole("button", { name: "Delete Replacement", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toHaveCount(0);
    await expect(
      page.locator(".replacement-stats .erp-stat-value").first(),
    ).toHaveText("0");
    await expect(page.getByText("No records to display")).toBeVisible();
  });
}
