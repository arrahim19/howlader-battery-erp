import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceFileName } from "../../apps/mobile/src/lib/invoice-file-name";

test("invoice PDF name preserves Bangla and the reference without path separators", () => {
  assert.equal(
    invoiceFileName("হাওলাদার ব্যাটারী হাউজ - HB-0022"),
    "হাওলাদার ব্যাটারী হাউজ - HB-0022.pdf",
  );
  assert.equal(
    invoiceFileName("Shop / Branch: A - HB-0022"),
    "Shop Branch A - HB-0022.pdf",
  );
  assert.equal(invoiceFileName("\u0000   ..."), "Sales Invoice.pdf");
  const longName = invoiceFileName("হাওলাদার ".repeat(30) + " - HB-0022");
  assert.ok(Buffer.byteLength(longName, "utf8") <= 240);
  assert.ok(longName.endsWith(" - HB-0022.pdf"));
});
