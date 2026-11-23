/** Shared serverless Drive protocol. No database/server/Google OAuth dependency.
 * The native/desktop host must keep pairing tokens and keys in secure storage.
 * This transport is not yet the ERP's local business/transaction engine.
 */
export type DrivePairing = {
  protocol: 1;
  serviceId: string;
  shopId: string;
  shopName: string;
  deviceId: string;
  deviceName: string;
  token: string;
};
export type DriveHead = {
  revision: number;
  writeId?: string;
  deviceId?: string;
  createdAt?: string;
  payloadFormat?: "a256gcm-v1";
  payloadHash?: string;
};
export type DriveClaim = {
  leaseId: string;
  expiresAt: number;
  head: DriveHead;
  shop: { id: string; name: string };
};
export type DriveWrite = {
  leaseId: string;
  baseRevision: number;
  writeId: string;
  payload: string;
  payloadFormat: "a256gcm-v1";
  payloadHash: string;
};
export class DriveSyncError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DriveSyncError";
  }
  get retryable() {
    return ["NETWORK", "BUSY", "SERVICE_UNAVAILABLE"].includes(this.code);
  }
}
export {
  GoogleAccountLogin,
  type GoogleLoginGrant,
  type PendingGoogleLogin,
} from "./google-login";
export {
  DriveReplica,
  type ReplicaMetadata,
  type ReplicaRepository,
} from "./replica";

export function validateDriveEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "script.google.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)
  )
    throw new DriveSyncError(
      "BAD_ENDPOINT",
      "Use the deployed Google Apps Script /exec URL.",
    );
  return url.href;
}

export class DriveSyncTransport {
  private readonly endpoint: string;
  private readonly pairing: DrivePairing;
  constructor(
    endpoint: string,
    pairing: DrivePairing,
    private readonly send: typeof fetch = fetch,
  ) {
    this.endpoint = validateDriveEndpoint(endpoint);
    if (
      pairing.protocol !== 1 ||
      !/^[a-f0-9]{64}$/.test(pairing.token) ||
      !pairing.serviceId ||
      !pairing.shopId ||
      !pairing.deviceId
    )
      throw new DriveSyncError(
        "BAD_PAIRING",
        "Invalid private device pairing file.",
      );
    this.pairing = { ...pairing };
  }
  private async call<T>(
    op: string,
    body: Record<string, unknown> = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.send.call(globalThis, this.endpoint, {
        method: "POST",
        redirect: "follow",
        credentials: "omit",
        // A simple cross-origin request: no Authorization/custom headers or
        // application/json preflight that Apps Script cannot customize.
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({
          ...body,
          protocol: 1,
          op,
          serviceId: this.pairing.serviceId,
          token: this.pairing.token,
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new DriveSyncError(
        "NETWORK",
        "Google sync could not be reached. Local work must be retained for retry.",
      );
    }
    if (!response.ok)
      throw new DriveSyncError(
        response.status === 429 || response.status >= 500
          ? "SERVICE_UNAVAILABLE"
          : "DEPLOYMENT_ACCESS",
        "Google sync is unavailable. Check the deployment and retain local work.",
      );
    let result: {
      ok?: boolean;
      data?: T;
      error?: { code?: string; message?: string };
    };
    try {
      result = await response.json();
    } catch {
      throw new DriveSyncError(
        "DEPLOYMENT_ACCESS",
        "Google returned a sign-in page or an invalid deployment response.",
      );
    }
    if (result.ok !== true)
      throw new DriveSyncError(
        result.error?.code || "SERVICE_UNAVAILABLE",
        result.error?.message || "Google sync failed. Retain local work.",
      );
    return result.data as T;
  }
  status() {
    return this.call<{
      shop: { id: string; name: string };
      head: DriveHead;
      activeDevice: { own: boolean; name: string; expiresAt: number } | null;
    }>("status");
  }
  claim() {
    return this.call<DriveClaim>("claim");
  }
  renew(leaseId: string) {
    return this.call<DriveClaim>("renew", { leaseId });
  }
  release(leaseId: string) {
    return this.call<{ released: boolean }>("release", { leaseId });
  }
  pull(knownRevision?: number) {
    return this.call<{ head: DriveHead; unchanged: boolean; payload?: string }>(
      "pull",
      knownRevision === undefined ? {} : { knownRevision },
    );
  }
  // The host must persist this exact write BEFORE sending it and preserve its
  // writeId/baseRevision/payload through network errors and process restarts.
  push(write: DriveWrite) {
    return this.call<{
      revision: number;
      currentRevision: number;
      writeId: string;
      repeated: boolean;
    }>("push", { ...write });
  }
}

const magic = new Uint8Array([72, 66, 83, 89, 78, 67, 48, 49]);
function cryptoProvider() {
  if (!globalThis.crypto?.subtle)
    throw new DriveSyncError(
      "CRYPTO_UNAVAILABLE",
      "Secure device encryption is unavailable in this runtime.",
    );
  return globalThis.crypto;
}
function keyBytes(hex: string) {
  if (!/^[a-f0-9]{64}$/i.test(hex))
    throw new DriveSyncError(
      "BAD_KEY",
      "A 256-bit shop encryption key is required.",
    );
  return new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));
}
function base64(bytes: Uint8Array) {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 32768)
    result += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(result);
}
function context(serviceId: string, shopId: string) {
  return new TextEncoder().encode(
    `Howlader ERP Sync v1\n${serviceId}\n${shopId}`,
  );
}
export function newShopEncryptionKey() {
  return [...cryptoProvider().getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function snapshotHash(payload: string) {
  return [
    ...new Uint8Array(
      await cryptoProvider().subtle.digest(
        "SHA-256",
        new TextEncoder().encode(payload),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function encryptSnapshot(
  value: unknown,
  hexKey: string,
  serviceId: string,
  shopId: string,
) {
  const crypto = cryptoProvider();
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes(hexKey),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: context(serviceId, shopId),
        tagLength: 128,
      },
      key,
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );
  const bytes = new Uint8Array(magic.length + iv.length + ciphertext.length);
  bytes.set(magic);
  bytes.set(iv, magic.length);
  bytes.set(ciphertext, magic.length + iv.length);
  return base64(bytes);
}
export async function decryptSnapshot<T>(
  payload: string,
  hexKey: string,
  serviceId: string,
  shopId: string,
): Promise<T> {
  const packed = new Uint8Array(
    [...atob(payload)].map((character) => character.charCodeAt(0)),
  );
  if (
    packed.length < 37 ||
    !magic.every((byte, index) => packed[index] === byte)
  )
    throw new DriveSyncError(
      "BAD_SNAPSHOT",
      "Unknown or incomplete encrypted snapshot.",
    );
  const crypto = cryptoProvider();
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes(hexKey),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: packed.slice(8, 20),
      additionalData: context(serviceId, shopId),
      tagLength: 128,
    },
    key,
    packed.slice(20),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
export type SnapshotCrypto = {
  randomId(): string;
  randomKey(): string;
  hash(payload: string): Promise<string>;
  encrypt(
    value: unknown,
    hexKey: string,
    serviceId: string,
    shopId: string,
  ): Promise<string>;
  decrypt<T>(
    payload: string,
    hexKey: string,
    serviceId: string,
    shopId: string,
  ): Promise<T>;
};
export const webSnapshotCrypto: SnapshotCrypto = {
  randomId: () => cryptoProvider().randomUUID(),
  randomKey: newShopEncryptionKey,
  hash: snapshotHash,
  encrypt: encryptSnapshot,
  decrypt: decryptSnapshot,
};
