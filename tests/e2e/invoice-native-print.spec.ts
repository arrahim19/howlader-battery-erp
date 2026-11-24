import { test, expect } from "@playwright/test";
import { buildSync } from "esbuild";

const bridge = buildSync({
  entryPoints: ["apps/mobile/src/shared-web/print-document.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "nativePrintTest",
  platform: "browser",
}).outputFiles[0].text;

for (const fail of [false, true])
  test(`native invoice print ${fail ? "keeps the invoice ready after a printer error" : "sends a complete offline A4 document"}`, async ({
    page,
  }) => {
    const customer = {
      id: "customer-1",
      name: "Customer One",
      phone: "01700000001",
      address: "Dhaka",
      active: true,
      totalSales: "100.00",
      due: "20.00",
    };
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
      else if (path.endsWith("/shop-profile"))
        data = {
          name: "হাওলাদার ব্যাটারী হাউজ",
          tagLine: "ব্যাটারির শো-রুম",
          address: "বরগুনা",
          phone: "01799639594",
        };
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
          total: 1,
          page: 1,
          pageSize: 50,
          items: [
            {
              id: "sale-1",
              invoiceNumber: "HB-0022",
              soldAt: "2026-11-25",
              status: "CONFIRMED",
              subtotal: "100.00",
              discount: "0.00",
              total: "100.00",
              paid: "80.00",
              due: "20.00",
              notes: "Deliver after 5 PM\n<b>Keep as text</b>",
              products: [
                {
                  id: "line-1",
                  name: "Auto Life",
                  model: "200",
                  quantity: "1",
                  unit: "pcs",
                  unitPrice: "100.00",
                  amount: "100.00",
                },
              ],
            },
          ],
        };
      return route.fulfill({ json: { data } });
    });
    await page.goto("/customers");
    await page
      .getByRole("button", { name: customer.name, exact: true })
      .click();
    await page.evaluate(() => {
      window.print = () => {};
    });
    await page
      .getByRole("button", { name: "Print invoice HB-0022", exact: true })
      .click();
    await expect(page).toHaveTitle("হাওলাদার ব্যাটারী হাউজ - HB-0022");
    await page.addScriptTag({ content: bridge });
    const result = await page.evaluate(async (fail) => {
      const printer = (
        window as unknown as {
          nativePrintTest: {
            connectNativePrint: (
              print: (value: { html: string; title: string }) => Promise<void>,
            ) => void;
            printDocument: () => Promise<void>;
          };
        }
      ).nativePrintTest;
      let document: { html: string; title: string } | undefined;
      printer.connectNativePrint(async (request) => {
        document = request;
        if (fail) throw new Error("Printer unavailable");
      });
      try {
        await printer.printDocument();
        return { document, error: "" };
      } catch (error) {
        return { document, error: (error as Error).message };
      }
    }, fail);
    expect(result.document?.title).toBe("হাওলাদার ব্যাটারী হাউজ - HB-0022");
    expect(result.document?.html).toContain("data:image/png;base64,");
    expect(result.document?.html).toContain("data:font/");
    expect(result.document?.html).not.toMatch(/url\(["']?(?:https?:|file:|\/)/);
    expect(result.document?.html).not.toContain("<script");
    expect(result.document?.html).not.toContain("Edit customer");
    if (fail) {
      expect(result.error).toBe("Printer unavailable");
      await expect(page.locator(".sale-invoice-print-sheet")).toHaveCount(1);
      return;
    }
    expect(result.error).toBe("");
    await expect(page.locator(".sale-invoice-print-sheet")).toHaveCount(0);
    const preview = await page.context().newPage();
    // This document must render without the app server or network assets.
    await preview.route("**/*", (route) => route.abort());
    await preview.setContent(result.document!.html);
    await preview.evaluate(() => document.fonts.ready);
    await expect(preview.locator(".invoice-shop-header h1")).toHaveText(
      "হাওলাদার ব্যাটারী হাউজ",
    );
    await expect(preview.locator(".invoice-note b")).toHaveCount(0);
    await preview.emulateMedia({ media: "print" });
    await preview.screenshot({
      path: test.info().outputPath("native-invoice.png"),
      fullPage: true,
    });
    const pdf = await preview.pdf({
      path: test.info().outputPath("native-invoice.pdf"),
      preferCSSPageSize: true,
      printBackground: true,
    });
    expect(
      (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length,
    ).toBe(1);
    await preview.close();
  });
