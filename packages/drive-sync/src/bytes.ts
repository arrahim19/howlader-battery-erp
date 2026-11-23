/** Small platform-neutral codecs for native runtimes without Web TextEncoder. */
export function utf8(value: string): Uint8Array {
  const result: number[] = [];
  for (const character of value) {
    let point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
    if (point < 0x80) result.push(point);
    else if (point < 0x800)
      result.push(0xc0 | (point >> 6), 0x80 | (point & 63));
    else if (point < 0x10000)
      result.push(
        0xe0 | (point >> 12),
        0x80 | ((point >> 6) & 63),
        0x80 | (point & 63),
      );
    else
      result.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 63),
        0x80 | ((point >> 6) & 63),
        0x80 | (point & 63),
      );
  }
  return new Uint8Array(result);
}
export function fromUtf8(value: Uint8Array) {
  return decodeURIComponent(
    Array.from(value, (byte) => "%" + byte.toString(16).padStart(2, "0")).join(
      "",
    ),
  );
}
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function toBase64(value: Uint8Array) {
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += 3) {
    const a = value[i],
      b = value[i + 1] ?? 0,
      c = value[i + 2] ?? 0;
    parts.push(
      alphabet[a >> 2] +
        alphabet[((a & 3) << 4) | (b >> 4)] +
        (i + 1 < value.length ? alphabet[((b & 15) << 2) | (c >> 6)] : "=") +
        (i + 2 < value.length ? alphabet[c & 63] : "="),
    );
  }
  return parts.join("");
}
export function fromBase64(value: string) {
  if (
    value.length % 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("Invalid base64 data.");
  const result: number[] = [];
  for (let i = 0; i < value.length; i += 4) {
    const a = alphabet.indexOf(value[i]),
      b = alphabet.indexOf(value[i + 1]);
    const c = alphabet.indexOf(value[i + 2]),
      d = alphabet.indexOf(value[i + 3]);
    result.push((a << 2) | (b >> 4));
    if (c >= 0) result.push(((b & 15) << 4) | (c >> 2));
    if (d >= 0) result.push(((c & 3) << 6) | d);
  }
  return new Uint8Array(result);
}
