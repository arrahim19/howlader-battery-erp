import type { LocalStore } from "./store-types";

// Web preview uses IndexedDB. Installed Android uses the .native SQLite adapter.
let database: Promise<IDBDatabase> | undefined;
export async function openLocalStore(): Promise<LocalStore> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("hawlader-offline-v1", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("documents", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const db = await database;
  const run = <T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction("documents", mode);
      const request = action(tx.objectStore("documents"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error ?? new Error("Local database transaction failed."));
    });
  return {
    async get<T>(key: string) {
      return (
        ((await run("readonly", (store) => store.get(key)))?.value as T) ?? null
      );
    },
    async put(key, value) {
      await run("readwrite", (store) => store.put({ key, value }));
    },
    async insert(key, value) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("documents", "readwrite");
        const store = tx.objectStore("documents");
        const check = store.getKey(key);
        check.onsuccess = () => {
          if (check.result === undefined) store.add({ key, value });
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
    async list<T>(prefix: string) {
      return (await run("readonly", (store) =>
        store.getAll(IDBKeyRange.bound(prefix, prefix + "\uffff")),
      )) as { key: string; value: T }[];
    },
    async remove(key) {
      await run("readwrite", (store) => store.delete(key));
    },
  };
}
