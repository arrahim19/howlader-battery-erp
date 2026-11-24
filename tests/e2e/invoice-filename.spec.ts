import { test, expect } from "@playwright/test";

for (const embedded of [false, true])
  test(`invoice PDF name keeps the reference through delayed mobile saving${embedded ? " in a mobile preview frame" : ""}`, async ({
    page,
  }) => {
    const customer = {
      id: "customer-1",
      name: "Customer One",
      phone: "01700000001",
      address: "Dhaka",
      active: true,
      totalSales: "200.00",
      due: "0.00",
    };
    const shopName = "হাওলাদার ব্যাটারী হাউজ";
    await page.route("**/api/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = {};
      if (path.endsWith("/auth/me"))
        data = {
          id: "owner",
          name: "Owner",
          login: "owner",
          roles: ["OWNER"],
          permissions: ["dashboard.read", "parties.customers", "sales.manage"],
        };
      else if (path.endsWith("/shop-profile")) data = { name: shopName };
      else if (path.endsWith("/customers"))
        data = {
          items: [customer],
          total: 1,
          page: 1,
          pageSize: 10,
          summary: {},
        };
      else if (path.endsWith("/sales"))
        data = {
          customer,
          total: 2,
          page: 1,
          pageSize: 50,
          items: ["HB-0022", "HB-0023"].map((invoiceNumber) => ({
            id: invoiceNumber,
            invoiceNumber,
            soldAt: "2026-11-25",
            status: "CONFIRMED",
            subtotal: "100.00",
            discount: "0.00",
            total: "100.00",
            paid: "100.00",
            due: "0.00",
            products: [
              {
                id: "line-1",
                name: "Battery",
                model: "200",
                quantity: "1",
                unit: "pcs",
                unitPrice: "100.00",
                amount: "100.00",
              },
            ],
          })),
        };
      return route.fulfill({ json: { data } });
    });
    if (embedded) {
      await page.route("**/invoice-frame-host", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><title>Mobile preview</title><iframe src="/customers" style="width:390px;height:844px"></iframe>',
        }),
      );
      await page.goto("/invoice-frame-host");
    } else await page.goto("/customers");
    const app = embedded ? page.frameLocator("iframe") : page;
    const originalTitle = await page.title();
    await app.getByRole("button", { name: customer.name, exact: true }).click();
    await app.locator("html").evaluate(() => {
      window.print = () => {
        document.documentElement.dataset.printTitle = document.title;
        // Some phone print services return before the save dialog reads the title.
        window.dispatchEvent(new Event("afterprint"));
      };
    });
    for (const reference of ["HB-0022", "HB-0023"]) {
      await app
        .getByRole("button", {
          name: `Print invoice ${reference}`,
          exact: true,
        })
        .click();
      const expectedTitle = `${shopName} - ${reference}`;
      await expect(app.locator("html")).toHaveAttribute(
        "data-print-title",
        expectedTitle,
      );
      await expect(app.locator(".sale-invoice-print-sheet")).toHaveCount(0);
      await expect(page).toHaveTitle(expectedTitle);
      // Let the print completion render and its effect cleanup finish as well.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await page.title()).toBe(expectedTitle);
    }
    await app
      .getByRole("button", { name: "Close customer details", exact: true })
      .click();
    await expect(page).toHaveTitle(originalTitle);
  });
