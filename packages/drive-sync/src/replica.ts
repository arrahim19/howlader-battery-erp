import {
  DriveSyncError,
  webSnapshotCrypto,
  type SnapshotCrypto,
  type DrivePairing,
  type DriveSyncTransport,
  type DriveWrite,
} from "./index";
export type ReplicaMetadata = {
  cloudRevision: number;
  syncedLocalRevision: number | null;
  lastSuccess: string | null;
  pending: { write: DriveWrite; localRevision: number } | null;
};
export interface ReplicaRepository<T> {
  local(): Promise<{ data: T; revision: number } | null>;
  replaceLocal(expected: number | null, data: T): Promise<boolean>;
  metadata(
    scope: string,
  ): Promise<{ revision: number; data: ReplicaMetadata } | null>;
  saveMetadata(
    scope: string,
    expected: number | null,
    data: ReplicaMetadata,
  ): Promise<boolean>;
}
type Remote = Awaited<ReturnType<DriveSyncTransport["pull"]>>;
/** Readers never hold a writer lease. A save claims briefly, refreshes before
 * changing business data, commits its exact snapshot, and releases automatically.
 * The lease serializes financial operations across independent devices; revision
 * CAS and durable write IDs still protect interrupted or old/offline uploads.
 */
export class DriveReplica<T> {
  private running: Promise<void> | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private delayed?: ReturnType<typeof setTimeout>;
  private leaseId = "";
  private readonly scope: string;
  private lastError: DriveSyncError | null = null;
  constructor(
    private readonly repository: ReplicaRepository<T>,
    private readonly transport: Pick<
      DriveSyncTransport,
      "claim" | "pull" | "push" | "release"
    >,
    private readonly pairing: DrivePairing,
    private readonly shopKey: string,
    private readonly validate: (value: unknown) => T,
    private readonly pristine: (value: T) => boolean,
    private readonly cryptoAdapter: SnapshotCrypto = webSnapshotCrypto,
  ) {
    this.scope = JSON.stringify([
      pairing.serviceId,
      pairing.shopId,
      pairing.deviceId,
    ]);
  }
  private async meta() {
    return (
      (await this.repository.metadata(this.scope)) || {
        revision: null,
        data: {
          cloudRevision: 0,
          syncedLocalRevision: null,
          lastSuccess: null,
          pending: null,
        },
      }
    );
  }
  private async save(
    current: { revision: number | null; data: ReplicaMetadata },
    data: ReplicaMetadata,
  ) {
    if (
      !(await this.repository.saveMetadata(this.scope, current.revision, data))
    )
      throw new DriveSyncError(
        "LOCAL_CHANGED",
        "Another local window changed its sync checkpoint. Retry unchanged work.",
      );
    return {
      revision: current.revision === null ? 0 : current.revision + 1,
      data,
    };
  }
  async status() {
    const meta = await this.meta(),
      local = await this.repository.local();
    return {
      syncing: Boolean(this.running),
      pending: Boolean(
        meta.data.pending ||
        (local && local.revision !== meta.data.syncedLocalRevision),
      ),
      cloudRevision: meta.data.cloudRevision,
      lastSuccess: meta.data.lastSuccess,
      error: this.lastError?.message || "",
      errorCode: this.lastError?.code || "",
    };
  }
  private track(task: Promise<void>) {
    this.running = task;
    const clear = () => {
      if (this.running === task) this.running = null;
    };
    void task.then(clear, clear);
    return task;
  }
  sync() {
    if (this.running) return this.running;
    return this.track(this.synchronize());
  }
  /** Wait for local background work, then keep one short cloud lease across the
   * refresh + local commit + upload. A second device waits and refreshes after it.
   * Confirmation is returned only after Drive acknowledges the saved revision.
   */
  async write<R>(work: () => Promise<R>): Promise<R> {
    while (this.running) await this.running.catch(() => {});
    let value: R;
    const task = this.synchronize(async () => {
      value = await work();
    });
    await this.track(task);
    return value!;
  }
  private async claim() {
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        return await this.transport.claim();
      } catch (e) {
        if (
          !(e instanceof DriveSyncError) ||
          !["DEVICE_BUSY", "BUSY"].includes(e.code)
        )
          throw e;
        if (Date.now() >= deadline)
          throw new DriveSyncError(
            e.code,
            "Another save is still completing. Automatic sync will retry; retry this same form in a moment.",
          );
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
  private async synchronize(work?: () => Promise<void>) {
    let held = false,
      businessFailure = false,
      posted = false;
    try {
      const checkpoint = await this.meta(),
        local = await this.repository.local();
      const dirty = Boolean(
        checkpoint.data.pending ||
        (local && local.revision !== checkpoint.data.syncedLocalRevision),
      );
      if (!work && !dirty) {
        const remote = await this.transport.pull(checkpoint.data.cloudRevision);
        await this.reconcile(remote.head.revision, false, remote);
      } else {
        const claim = await this.claim();
        this.leaseId = claim.leaseId;
        held = true;
        await this.reconcile(claim.head.revision, true);
        if (work) {
          if ((await this.status()).pending)
            throw new DriveSyncError(
              "PENDING_WORK",
              "Previous local work is still awaiting confirmation. Retry this same form after sync.",
            );
          try {
            await work();
            posted = true;
          } catch (e) {
            businessFailure = true;
            throw e;
          }
          await this.reconcile((await this.meta()).data.cloudRevision, true);
          if ((await this.status()).pending)
            throw new DriveSyncError(
              "PENDING_WORK",
              "Saved locally; Drive confirmation is pending. Retry this same form without creating a new transaction.",
            );
        }
      }
      this.lastError = null;
    } catch (e) {
      if (businessFailure) {
        this.lastError = null;
        throw e;
      }
      const failure =
        e instanceof DriveSyncError
          ? e
          : new DriveSyncError(
              "SYNC_FAILED",
              "Sync or decryption failed. Local data and pending work were retained.",
            );
      this.lastError = posted
        ? new DriveSyncError(
            failure.code,
            "Saved on this device, but Drive confirmation is pending. Retry this same form; do not enter the transaction again.",
          )
        : failure;
      throw this.lastError;
    } finally {
      if (held) {
        const id = this.leaseId;
        this.leaseId = "";
        try {
          await this.transport.release(id);
        } catch {
          /* Keep the original result/error. Expiry is crash recovery, never data deletion. */
        }
      }
    }
  }
  private async reconcile(
    headRevision: number,
    upload: boolean,
    cached?: Remote,
  ) {
    for (let pass = 0; pass < 3; pass++) {
      let checkpoint = await this.meta(),
        local = await this.repository.local();
      if (
        !checkpoint.data.pending &&
        headRevision !== checkpoint.data.cloudRevision
      ) {
        if (
          local &&
          local.revision !== checkpoint.data.syncedLocalRevision &&
          !(
            checkpoint.data.syncedLocalRevision === null &&
            this.pristine(local.data)
          )
        )
          throw new DriveSyncError(
            "REVISION_CONFLICT",
            "Drive has newer data and this device has unsynced work. Both copies are retained for review; no data was overwritten.",
          );
        const remote =
          cached && cached.head.revision === headRevision
            ? cached
            : await this.transport.pull();
        cached = undefined;
        if (
          !remote.payload ||
          remote.head.payloadFormat !== "a256gcm-v1" ||
          !remote.head.payloadHash ||
          (await this.cryptoAdapter.hash(remote.payload)) !==
            remote.head.payloadHash
        )
          throw new DriveSyncError(
            "CORRUPT_BACKUP",
            "The cloud snapshot could not be verified. Local data was retained.",
          );
        const decoded = this.validate(
          await this.cryptoAdapter.decrypt(
            remote.payload,
            this.shopKey,
            this.pairing.serviceId,
            this.pairing.shopId,
          ),
        );
        const expected = local?.revision ?? null;
        if (!(await this.repository.replaceLocal(expected, decoded)))
          throw new DriveSyncError(
            "LOCAL_CHANGED",
            "Local work changed during refresh; nothing was overwritten.",
          );
        checkpoint = await this.save(checkpoint, {
          ...checkpoint.data,
          cloudRevision: remote.head.revision,
          syncedLocalRevision: expected === null ? 0 : expected + 1,
          lastSuccess: new Date().toISOString(),
        });
        headRevision = remote.head.revision;
        local = await this.repository.local();
      }
      if (!upload) break;
      if (!checkpoint.data.pending) {
        if (!local || local.revision === checkpoint.data.syncedLocalRevision)
          break;
        const valid = this.validate(local.data),
          payload = await this.cryptoAdapter.encrypt(
            valid,
            this.shopKey,
            this.pairing.serviceId,
            this.pairing.shopId,
          );
        const pending = {
          localRevision: local.revision,
          write: {
            leaseId: this.leaseId,
            baseRevision: checkpoint.data.cloudRevision,
            writeId: this.cryptoAdapter.randomId(),
            payload,
            payloadFormat: "a256gcm-v1" as const,
            payloadHash: await this.cryptoAdapter.hash(payload),
          },
        };
        checkpoint = await this.save(checkpoint, {
          ...checkpoint.data,
          pending,
        });
      }
      const pending = checkpoint.data.pending!;
      const ack = await this.transport.push({
        ...pending.write,
        leaseId: this.leaseId,
      });
      if (
        ack.writeId !== pending.write.writeId ||
        ack.revision !== pending.write.baseRevision + 1 ||
        ack.currentRevision < ack.revision
      )
        throw new DriveSyncError(
          "BAD_ACK",
          "Drive returned an inconsistent acknowledgement. Local pending work was retained.",
        );
      await this.save(checkpoint, {
        cloudRevision: ack.revision,
        syncedLocalRevision: pending.localRevision,
        pending: null,
        lastSuccess: new Date().toISOString(),
      });
      headRevision = ack.currentRevision;
    }
  }
  changed() {
    if (!this.delayed)
      this.delayed = setTimeout(() => {
        this.delayed = undefined;
        void this.sync().catch(() => {});
      }, 1000);
  }
  start() {
    if (!this.timer)
      this.timer = setInterval(() => void this.sync().catch(() => {}), 10000);
    void this.sync().catch(() => {});
  }
  stop() {
    clearInterval(this.timer);
    clearTimeout(this.delayed);
    this.timer = undefined;
    this.delayed = undefined;
  }
  /** Logout flushes pending work; ordinary device use never requires handoff. */
  async releaseIfClean() {
    this.stop();
    await this.sync();
    if ((await this.status()).pending)
      throw new DriveSyncError(
        "PENDING_WORK",
        "Finish local sync before signing out. Local work was retained.",
      );
  }
}
