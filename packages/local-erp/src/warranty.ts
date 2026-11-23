/** Calendar-month expiry: Jan 31 + one month clamps to February's last day. */
export function warrantyExpiry(start: string, months: number) {
  if (
    !Number.isInteger(months) ||
    months < 0 ||
    months > 120 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    !Number.isFinite(Date.parse(start)) ||
    new Date(start).toISOString().slice(0, 10) !== start
  )
    throw new Error("Invalid warranty date or month count.");
  const input = new Date(start + "T00:00:00Z");
  const result = new Date(
    Date.UTC(input.getUTCFullYear(), input.getUTCMonth() + months, 1),
  );
  const last = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(input.getUTCDate(), last));
  return result.toISOString().slice(0, 10);
}
