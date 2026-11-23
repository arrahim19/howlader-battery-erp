import {
  DriveSyncError,
  webSnapshotCrypto,
  validateDriveEndpoint,
  type SnapshotCrypto,
  type DrivePairing,
} from "./index";
export type PendingGoogleLogin = {
  requestId: string;
  verifier: string;
  proposedShopKey: string;
  deviceId: string;
  deviceName: string;
};
export type GoogleLoginGrant = {
  pairing: DrivePairing;
  shopKey: string;
  expiresAt: number;
  user: {
    id: string;
    email: string;
    name: string;
    shop: { id: string; name: string; branchName: string };
  };
};
export class GoogleAccountLogin {
  private readonly endpoint: string;
  constructor(
    endpoint: string,
    private readonly send: typeof fetch = fetch,
    private readonly cryptoAdapter: SnapshotCrypto = webSnapshotCrypto,
  ) {
    this.endpoint = validateDriveEndpoint(endpoint);
  }
  prepare(deviceId: string, deviceName: string): PendingGoogleLogin {
    if (
      !/^[a-zA-Z0-9-]{16,80}$/.test(deviceId) ||
      !deviceName.trim() ||
      deviceName.length > 80
    )
      throw new DriveSyncError("BAD_DEVICE", "Invalid device identity.");
    return {
      requestId: this.cryptoAdapter.randomId(),
      verifier: this.cryptoAdapter.randomKey(),
      proposedShopKey: this.cryptoAdapter.randomKey(),
      deviceId,
      deviceName: deviceName.trim(),
    };
  }
  private async call<T>(op: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.send.call(globalThis, this.endpoint, {
        method: "POST",
        credentials: "omit",
        redirect: "follow",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ ...body, protocol: 1, op }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new DriveSyncError(
        "NETWORK",
        "Google login could not connect. Keep the pending sign-in and try again.",
      );
    }
    if (!response.ok)
      throw new DriveSyncError(
        "DEPLOYMENT_ACCESS",
        "Google login deployment is unavailable.",
      );
    let result: {
      ok?: boolean;
      data?: T;
      error?: { code: string; message: string };
    };
    try {
      result = await response.json();
    } catch {
      throw new DriveSyncError(
        "DEPLOYMENT_ACCESS",
        "Google did not return the app login response.",
      );
    }
    if (result.ok !== true)
      throw new DriveSyncError(
        result.error?.code || "LOGIN_DENIED",
        result.error?.message || "Google login failed.",
      );
    return result.data as T;
  }
  /** Persist the pending proof in native/desktop secure storage BEFORE start(). */
  async start(pending: PendingGoogleLogin) {
    const result = await this.call<{ url: string; expiresAt: number }>(
      "loginStart",
      {
        requestId: pending.requestId,
        challenge: await this.cryptoAdapter.hash(pending.verifier),
        proposedShopKey: pending.proposedShopKey,
        deviceId: pending.deviceId,
        deviceName: pending.deviceName,
      },
    );
    const url = new URL(result.url);
    if (
      url.origin !== "https://accounts.google.com" ||
      url.pathname !== "/o/oauth2/v2/auth" ||
      url.searchParams.get("response_type") !== "code" ||
      url.searchParams.get("code_challenge_method") !== "S256"
    )
      throw new DriveSyncError(
        "BAD_LOGIN_URL",
        "Unexpected Google sign-in address.",
      );
    return result;
  }
  async poll(pending: PendingGoogleLogin) {
    const result = await this.call<
      { status: "pending" } | { status: "complete"; grant: GoogleLoginGrant }
    >("loginPoll", {
      requestId: pending.requestId,
      verifier: pending.verifier,
    });
    if (result.status === "complete") {
      const grant = result.grant;
      if (
        !grant ||
        grant.pairing?.deviceId !== pending.deviceId ||
        grant.user?.shop?.id !== grant.pairing?.shopId ||
        !/^[a-f0-9]{64}$/.test(grant.shopKey) ||
        !/^[a-f0-9]{64}$/.test(grant.pairing.token) ||
        !grant.user.id ||
        !grant.user.email ||
        grant.pairing.protocol !== 1 ||
        !grant.pairing.serviceId ||
        !Number.isFinite(grant.expiresAt) ||
        grant.expiresAt <= Date.now()
      )
        throw new DriveSyncError(
          "BAD_LOGIN_GRANT",
          "Google login returned an invalid account binding.",
        );
    } else if (result.status !== "pending")
      throw new DriveSyncError(
        "BAD_LOGIN_GRANT",
        "Unknown Google login state.",
      );
    return result;
  }
  /** Acknowledge only AFTER the host durably saves the grant's keys and account. */
  acknowledge(pending: PendingGoogleLogin) {
    return this.call<{ acknowledged: boolean }>("loginAck", {
      requestId: pending.requestId,
      verifier: pending.verifier,
    });
  }
}
