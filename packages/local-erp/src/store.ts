import type { LocalErpState, LocalErpStore } from "./types";

/** Structural boundary implemented by Expo SQLite and the desktop SQLite host.
 * One compare-and-swap SQL statement commits stock, invoices, journal and replay
 * result together. A second app instance cannot silently overwrite a revision.
 */
export interface LocalSqlDatabase {
  execAsync(sql: string): Promise<void>;
  getFirstAsync<T>(sql: string, ...values: string[]): Promise<T | null>;
}
export async function sqliteErpStore(
  database: LocalSqlDatabase,
): Promise<LocalErpStore> {
  await database.execAsync(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS local_erp_snapshots (
      shop_id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL,
      body TEXT NOT NULL CHECK(json_valid(body))
    );`);
  return {
    async load(shopId) {
      const row = await database.getFirstAsync<{
        revision: number;
        body: string;
      }>(
        "SELECT revision, body FROM local_erp_snapshots WHERE shop_id = ?",
        shopId,
      );
      return row
        ? {
            revision: row.revision,
            state: JSON.parse(row.body) as LocalErpState,
          }
        : null;
    },
    async commit(shopId, expectedRevision, state) {
      if (state.shopId !== shopId)
        throw new Error("Local shop scope mismatch.");
      const body = JSON.stringify(state);
      const changed =
        expectedRevision === null
          ? await database.getFirstAsync<{ revision: number }>(
              "INSERT INTO local_erp_snapshots(shop_id,revision,body) VALUES (?,0,?) ON CONFLICT(shop_id) DO NOTHING RETURNING revision",
              shopId,
              body,
            )
          : await database.getFirstAsync<{ revision: number }>(
              "UPDATE local_erp_snapshots SET revision=revision+1,body=? WHERE shop_id=? AND revision=? RETURNING revision",
              body,
              shopId,
              String(expectedRevision),
            );
      return Boolean(changed);
    },
  };
}
