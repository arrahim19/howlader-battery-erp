import * as SQLite from "expo-sqlite";
import { sqliteStore } from "./sqlite-store";

let database: ReturnType<typeof sqliteStore> | undefined;
export const openLocalStore = () => {
  database ??= (async () => {
    const started = Date.now();
    if (process.env.NODE_ENV !== "production")
      console.info("[login] opening SQLite");
    // Opening the small database handle synchronously avoids Expo Go's stalled
    // asynchronous open path. Business queries remain asynchronous below.
    const db = SQLite.openDatabaseSync("hawlader-offline-v1.db");
    if (process.env.NODE_ENV !== "production")
      console.info(`[login] SQLite opened: ${Date.now() - started}ms`);
    const store = await sqliteStore(db);
    if (process.env.NODE_ENV !== "production")
      console.info(`[login] SQLite schema ready: ${Date.now() - started}ms`);
    return store;
  })().catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
};
