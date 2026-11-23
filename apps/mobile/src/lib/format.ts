export const money = (value: string | number | undefined | null) =>
  "৳ " +
  Number(value ?? 0).toLocaleString("en-BD", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const dateText = (value?: string | null) =>
  value
    ? new Date(value).toLocaleDateString("en-GB", {
        timeZone: "Asia/Dhaka",
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";
export function cents(value: string) {
  if (!/^\d{1,14}(?:\.\d{1,2})?$/.test(value))
    throw new Error("Enter an amount with up to two decimal places.");
  const [whole, part = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(part.padEnd(2, "0"));
}
export const amount = (value: bigint) =>
  `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
