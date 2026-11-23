import type { LocalErpState, LocalErpStore } from "./types";
import type {
  ReplicaMetadata,
  ReplicaRepository,
} from "../../drive-sync/src/replica";

/** Atomic IndexedDB CAS for the desktop browser adapter. No web server API.
 * Installed phones use the SQLite adapter instead. Never clear this database
 * to resolve a cloud revision conflict or an expired Google login.
 */
export async function browserDatabase() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("howlader-local-business-v2", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("records");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const get = <T>(key: string): Promise<T | null> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction("records", "readonly"),
        r = tx.objectStore("records").get(key);
      tx.oncomplete = () => resolve(r.result ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  const put = (key: string, value: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      tx.objectStore("records").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  const cas = (
    key: string,
    expected: number | null,
    data: unknown,
  ): Promise<boolean> =>
    new Promise((resolve, reject) => {
      let saved = false;
      const tx = db.transaction("records", "readwrite"),
        store = tx.objectStore("records"),
        r = store.get(key);
      r.onsuccess = () => {
        const old = r.result;
        if ((old?.revision ?? null) !== expected) return;
        store.put(
          { revision: expected === null ? 0 : expected + 1, data },
          key,
        );
        saved = true;
      };
      tx.oncomplete = () => resolve(saved);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  let wrapping = await get<CryptoKey>("wrapping-key");
  if (!wrapping) {
    const candidate = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    // Separate tabs must agree on one durable nonextractable key.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite"),
        store = tx.objectStore("records"),
        r = store.get("wrapping-key");
      r.onsuccess = () => {
        if (!r.result) store.put(candidate, "wrapping-key");
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    wrapping = await get<CryptoKey>("wrapping-key");
  }
  if (!wrapping) throw new Error("Secure desktop storage is unavailable.");
  const wrapKey = wrapping;
  return {
    get,
    put,
    cas,
    async secret<T>(key: string): Promise<T | null> {
      const record = await get<{ iv: Uint8Array; body: ArrayBuffer }>(
        "secret:" + key,
      );
      if (!record) return null;
      const clear = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: new Uint8Array(record.iv),
          additionalData: new TextEncoder().encode(key),
        },
        wrapKey,
        record.body,
      );
      return JSON.parse(new TextDecoder().decode(clear));
    },
    async saveSecret(key: string, value: unknown) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const body = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(key) },
        wrapKey,
        new TextEncoder().encode(JSON.stringify(value)),
      );
      await put("secret:" + key, { iv, body });
    },
    business(shopId: string): {
      store: LocalErpStore;
      repository: ReplicaRepository<LocalErpState>;
    } {
      const key = "business:" + shopId;
      const store: LocalErpStore = {
        async load() {
          const row = await get<{ revision: number; data: LocalErpState }>(key);
          return row ? { revision: row.revision, state: row.data } : null;
        },
        commit(id, revision, state) {
          if (id !== shopId || state.shopId !== shopId)
            throw new Error("Wrong shop database.");
          return cas(key, revision, state);
        },
      };
      const repository: ReplicaRepository<LocalErpState> = {
        local: () => get(key),
        replaceLocal: (revision, data) => cas(key, revision, data),
        metadata: (scope) =>
          get<{ revision: number; data: ReplicaMetadata }>("sync:" + scope),
        saveMetadata: (scope, revision, data) =>
          cas("sync:" + scope, revision, data),
      };
      return { store, repository };
    },
  };
}
