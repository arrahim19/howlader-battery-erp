import { utf8 } from "../../../../packages/drive-sync/src/bytes";

function fitName(value: string, budget: number): string {
  let result = "";
  for (const character of value) {
    budget -= utf8(character).length;
    if (budget < 0) break;
    result += character;
  }
  return result.trim();
}

export function invoiceFileName(title: string): string {
  const name = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  const split = name.lastIndexOf(" - ");
  const reference =
    split >= 0 ? ` - ${fitName(name.slice(split + 3), 80)}` : "";
  const shop = split >= 0 ? name.slice(0, split) : name || "Sales Invoice";
  // Android filenames are limited in UTF-8 bytes. Keep the reference even when
  // a long Bangla shop name needs shortening.
  return `${fitName(shop, 236 - utf8(reference).length)}${reference}.pdf`;
}
