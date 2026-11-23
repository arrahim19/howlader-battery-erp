import * as Crypto from "expo-crypto";
import {
  AESEncryptionKey,
  AESSealedData,
  aesEncryptAsync,
  aesDecryptAsync,
} from "expo-crypto";
import type { SnapshotCrypto } from "../../../../packages/drive-sync/src";
import {
  utf8,
  fromUtf8,
  toBase64,
  fromBase64,
} from "../../../../packages/drive-sync/src/bytes";
const magic = new Uint8Array([72, 66, 83, 89, 78, 67, 48, 49]);
const context = (serviceId: string, shopId: string) =>
  utf8(`Howlader ERP Sync v1\n${serviceId}\n${shopId}`);
export const nativeDriveCrypto: SnapshotCrypto = {
  randomId: Crypto.randomUUID,
  randomKey: () =>
    Array.from(Crypto.getRandomBytes(32), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  hash: (value) =>
    Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
  async encrypt(value, key, serviceId, shopId) {
    const imported = await AESEncryptionKey.import(key, "hex");
    const sealed = await aesEncryptAsync(
      utf8(JSON.stringify(value)),
      imported,
      {
        nonce: { length: 12 },
        tagLength: 16,
        additionalData: context(serviceId, shopId),
      },
    );
    const combined = await sealed.combined();
    if (typeof combined === "string")
      throw new Error("Unexpected native encryption output.");
    const bytes = new Uint8Array(magic.length + combined.length);
    bytes.set(magic);
    bytes.set(combined, magic.length);
    return toBase64(bytes);
  },
  async decrypt<T>(
    payload: string,
    key: string,
    serviceId: string,
    shopId: string,
  ): Promise<T> {
    const bytes = fromBase64(payload);
    if (
      bytes.length < 37 ||
      !magic.every((byte, index) => bytes[index] === byte)
    )
      throw new Error("Invalid encrypted snapshot.");
    const imported = await AESEncryptionKey.import(key, "hex");
    const sealed = AESSealedData.fromCombined(bytes.subarray(8), {
      ivLength: 12,
      tagLength: 16,
    });
    const clear = await aesDecryptAsync(sealed, imported, {
      output: "bytes",
      additionalData: context(serviceId, shopId),
    });
    return JSON.parse(fromUtf8(clear)) as T;
  },
};
