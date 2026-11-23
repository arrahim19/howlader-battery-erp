import type {
  ReplicaMetadata,
  ReplicaRepository,
} from "../../drive-sync/src/replica";
import { sqliteErpStore, type LocalSqlDatabase } from "./store";
import type { LocalErpState } from "./types";
/** Durable checkpoints live beside the real business document in SQLite.
 * Snapshot revision and sync revision are independent; an upload acknowledgement
 * only marks the captured business revision synced, never newer local work.
 */
export async function sqliteDriveReplicaStore(
  database: LocalSqlDatabase,
  shopId: string,
): Promise<ReplicaRepository<LocalErpState>> {
  const business = await sqliteErpStore(database);
  await database.execAsync(
    "CREATE TABLE IF NOT EXISTS drive_sync_checkpoints(scope TEXT PRIMARY KEY NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)))",
  );
  return {
    async local() {
      const row = await business.load(shopId);
      return row ? { data: row.state, revision: row.revision } : null;
    },
    replaceLocal(expected, data) {
      return business.commit(shopId, expected, data);
    },
    async metadata(scope) {
      const row = await database.getFirstAsync<{
        revision: number;
        body: string;
      }>(
        "SELECT revision,body FROM drive_sync_checkpoints WHERE scope=?",
        scope,
      );
      return row
        ? {
            revision: row.revision,
            data: JSON.parse(row.body) as ReplicaMetadata,
          }
        : null;
    },
    async saveMetadata(scope, expected, data) {
      const body = JSON.stringify(data);
      const row =
        expected === null
          ? await database.getFirstAsync<{ revision: number }>(
              "INSERT INTO drive_sync_checkpoints(scope,revision,body) VALUES (?,0,?) ON CONFLICT(scope) DO NOTHING RETURNING revision",
              scope,
              body,
            )
          : await database.getFirstAsync<{ revision: number }>(
              "UPDATE drive_sync_checkpoints SET revision=revision+1,body=? WHERE scope=? AND revision=? RETURNING revision",
              body,
              scope,
              String(expected),
            );
      return Boolean(row);
    },
  };
}
