import {
  LocalErp,
  LocalErpError,
  validateLocalState,
  type LocalErpState,
  type LocalErpStore,
} from "./index";
import {
  DriveReplica,
  DriveSyncTransport,
  type GoogleLoginGrant,
  type ReplicaRepository,
  type SnapshotCrypto,
} from "../../drive-sync/src";

export type DeviceCommand =
  | "category"
  | "profile"
  | "contact"
  | "product"
  | "name"
  | "purchase"
  | "sale"
  | "payment"
  | "expense"
  | "replacement"
  | "dispatch"
  | "receive"
  | "deliver"
  | "reject"
  | "cancel";
export const localOwnerPermissions = [
  "settings.manage",
  "catalog.write",
  "parties.suppliers",
  "parties.customers",
  "purchases.manage",
  "sales.manage",
  "finance.read",
  "replacements.intake.stock",
  "replacements.intake.customer",
  "replacements.dispatch",
  "replacements.receive",
  "replacements.deliver",
  "replacements.resolve",
  "transactions.reverse",
];
/** Owns the authenticated local engine and its durable Drive checkpoint.
 * The first successful cloud check is required before a new device can post.
 * No app password, arbitrary email or supplied shop ID can construct a session.
 */
export class LocalDevice {
  readonly erp: LocalErp;
  readonly replica: DriveReplica<LocalErpState>;
  private ready = false;
  private paused = false;
  private commits = new Set<Promise<unknown>>();
  constructor(
    readonly grant: GoogleLoginGrant,
    endpoint: string,
    store: LocalErpStore,
    repository: ReplicaRepository<LocalErpState>,
    private readonly crypto: SnapshotCrypto,
    send: typeof fetch = fetch,
  ) {
    this.erp = new LocalErp(store, grant.user.shop.id, {
      id: grant.user.id,
      permissions: localOwnerPermissions,
    });
    this.replica = new DriveReplica(
      repository,
      new DriveSyncTransport(endpoint, grant.pairing, send),
      grant.pairing,
      grant.shopKey,
      (value) => {
        const state = value as LocalErpState;
        validateLocalState(state, grant.user.shop.id);
        return state;
      },
      (state) => state.sequence === 0,
      crypto,
    );
  }
  async open() {
    await this.replica.sync();
    await this.erp.snapshot();
    this.ready = true;
  }
  async view() {
    return {
      user: this.grant.user,
      state: await this.erp.snapshot(),
      sync: await this.replica.status(),
      ready: this.ready && !this.paused,
      expired: this.grant.expiresAt <= Date.now(),
    };
  }
  async command(operation: DeviceCommand, key: string, input: unknown) {
    if (!this.ready || this.paused)
      throw new LocalErpError(
        "NOT_READY",
        "Connect to Drive to finish restoring this device before making changes.",
      );
    if (this.grant.expiresAt <= Date.now())
      throw new LocalErpError(
        "LOGIN_EXPIRED",
        "Sign in with Google again. Your local data is retained.",
      );
    // The typed engine validates every field and permission before committing.
    // Narrowing here cannot turn an unsupported action into another operation.
    const methods = {
      category: "createCategory",
      profile: "saveShopProfile",
      contact: "createContact",
      product: "createProduct",
      name: "createProductName",
      purchase: "receivePurchase",
      sale: "completeSale",
      payment: "recordPayment",
      expense: "recordExpense",
      replacement: "intakeReplacement",
      dispatch: "dispatchReplacement",
      receive: "receiveReplacement",
      deliver: "deliverReplacement",
      reject: "rejectReplacement",
      cancel: "cancelReplacement",
    } as const;
    const method = methods[operation];
    if (!method || !Object.hasOwn(methods, operation))
      throw new LocalErpError(
        "INVALID_OPERATION",
        "Unsupported local operation.",
      );
    const invoke = this.erp[method].bind(this.erp) as (
      key: string,
      input: unknown,
    ) => Promise<unknown>;
    const commit = this.replica.write(() => invoke(key, input));
    this.commits.add(commit);
    try {
      const result = await commit;
      return result;
    } finally {
      this.commits.delete(commit);
    }
  }
  async sync() {
    await this.replica.sync();
    if (!this.ready) {
      await this.erp.snapshot();
      this.ready = true;
    }
  }
  async handoff() {
    this.paused = true;
    try {
      await Promise.allSettled([...this.commits]);
      await this.replica.releaseIfClean();
    } catch (error) {
      this.paused = false;
      throw error;
    }
  }
  newKey() {
    return this.crypto.randomId();
  }
  stop() {
    this.paused = true;
    this.replica.stop();
  }
}
export type DeviceView = Awaited<ReturnType<LocalDevice["view"]>>;
