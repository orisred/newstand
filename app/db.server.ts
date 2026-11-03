import { PrismaD1 } from "@prisma/adapter-d1";
import { PrismaClient } from "./generated/prisma/client";

/**
 * Creates a Prisma client on the D1 binding. Call it once per request or queue
 * batch, and don't keep the client at module scope: a Worker isolate serves many
 * requests, and a promise shared between them can hang.
 *
 * D1 has no interactive transactions, and the adapter does not make `$transaction`
 * or nested writes atomic. Use idempotent writes on unique keys, and `env.DB.batch`
 * when several rows must change together.
 */
export function createDb(db: D1Database) {
  return new PrismaClient({ adapter: new PrismaD1(db) });
}
