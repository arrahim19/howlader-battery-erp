import type { LocalStore } from "./store-types";

// This small SQL boundary also runs against real SQLite in the Node test suite.
export interface SqlDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: string[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: string[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: string[]): Promise<T[]>;
}
export async function sqliteStore(db: SqlDatabase): Promise<LocalStore> {
  await db.execAsync(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    PRAGMA user_version = 1;`);
  return {
    async get<T>(key: string) {
      const row = await db.getFirstAsync<{ value: string }>(
        "SELECT value FROM documents WHERE key = ?",
        key,
      );
      return row ? (JSON.parse(row.value) as T) : null;
    },
    async put(key, value) {
      await db.runAsync(
        "INSERT INTO documents(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        key,
        JSON.stringify(value),
      );
    },
    async insert(key, value) {
      await db.runAsync(
        "INSERT OR IGNORE INTO documents(key,value) VALUES (?,?)",
        key,
        JSON.stringify(value),
      );
    },
    async list<T>(prefix: string) {
      const rows = await db.getAllAsync<{ key: string; value: string }>(
        "SELECT key,value FROM documents WHERE substr(key,1,?) = ? ORDER BY key",
        String(prefix.length),
        prefix,
      );
      return rows.map((row) => ({
        key: row.key,
        value: JSON.parse(row.value) as T,
      }));
    },
    async remove(key) {
      await db.runAsync("DELETE FROM documents WHERE key = ?", key);
    },
  };
}
