import {
  createInvoicePrintDocument,
  type InvoicePrintDocument,
} from "../../../web/src/lib/invoice-print-document";

let nativePrint: ((document: InvoicePrintDocument) => Promise<void>) | null =
  null;
export function connectNativePrint(next: typeof nativePrint) {
  nativePrint = next;
}
export async function printDocument(): Promise<void> {
  const send = nativePrint;
  if (!send) {
    if (document.documentElement.hasAttribute("data-native-workspace"))
      throw new Error("The native printer is connecting. Please try again.");
    window.print();
    return;
  }
  const sheet = document.querySelector<HTMLElement>(
    ".sale-invoice-print-sheet",
  );
  if (!sheet) throw new Error("Prepare an invoice before printing.");
  await send(await createInvoicePrintDocument(sheet, document.title));
  window.dispatchEvent(new Event("afterprint"));
}
