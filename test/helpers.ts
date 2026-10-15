import { openDb, type DB } from "../server/db.js";
import { seedAllowlist } from "../server/ownership/allowlist.js";

/** Fresh in-memory database with seeds, for isolated tests. */
export function freshDb(): DB {
  const db = openDb(":memory:");
  seedAllowlist(db);
  return db;
}
