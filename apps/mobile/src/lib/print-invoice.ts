import * as Print from "expo-print";
import { Directory, File, Paths } from "expo-file-system";
import { randomUUID } from "expo-crypto";
import type { InvoicePrintDocument } from "../../../web/src/lib/invoice-print-document";
import { invoiceFileName } from "./invoice-file-name";

export async function printInvoice({
  html,
  title,
}: InvoicePrintDocument): Promise<void> {
  if (!html.trim()) throw new Error("The invoice is empty. Please try again.");
  const result = await Print.printToFileAsync({
    html,
    width: 595,
    height: 842,
    base64: true,
  });
  if (!result.base64)
    throw new Error("The invoice PDF could not be read. Please try again.");
  const directory = new Directory(
    Paths.cache,
    "printed-invoices",
    randomUUID(),
  );
  await directory.create({ intermediates: true });
  // Expo Go's Print cache sits outside FileSystem's experience sandbox, so
  // moving result.uri fails READ permission checks. Write the returned PDF
  // bytes into our own cache instead; this also works in the standalone APK.
  const pdf = new File(directory, invoiceFileName(title));
  await pdf.create();
  await pdf.write(result.base64, { encoding: "base64" });
  // Android's file print adapter uses the filename for Save as PDF. Retain the
  // cache file: printAsync resolves before the system finishes reading it.
  await Print.printAsync({ uri: pdf.uri });
}
