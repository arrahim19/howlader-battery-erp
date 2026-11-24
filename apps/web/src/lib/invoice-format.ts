const small = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const tens = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

function words(value: bigint): string {
  for (const [scale, label] of [
    [10000000n, "Crore"],
    [100000n, "Lakh"],
    [1000n, "Thousand"],
    [100n, "Hundred"],
  ] as const) {
    if (value >= scale)
      return `${words(value / scale)} ${label}${value % scale ? " " + words(value % scale) : ""}`;
  }
  if (value < 20n) return small[Number(value)];
  return (
    tens[Number(value / 10n)] +
    (value % 10n ? " " + small[Number(value % 10n)] : "")
  );
}

/** Formats stored decimal strings without losing precision to floating point. */
export function invoiceAmount(value?: string | null): string {
  if (value == null || !/^-?\d+(?:\.\d{1,2})?$/.test(value)) return "—";
  const [whole, fraction = ""] = value.split(".");
  return `${BigInt(whole).toLocaleString("en-BD")}.${fraction.padEnd(2, "0")}`;
}

export function takaInWords(value: string): string {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return "Amount unavailable";
  const [whole, fraction = ""] = value.split(".");
  const paisa = BigInt(fraction.padEnd(2, "0"));
  return `${words(BigInt(whole))} Taka${paisa ? " and " + words(paisa) + " Paisa" : ""} Only`;
}
