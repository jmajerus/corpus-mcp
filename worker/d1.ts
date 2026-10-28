import type { PublicStore } from "../src/public/store.js";

/** The part of the D1 binding the public site uses, so the Worker needs no Cloudflare type package. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

/** The snapshot's replica in D1, as the public pages read it. */
export function d1Store(db: D1Database): PublicStore {
  const statement = (sql: string, params: unknown[]) => (params.length ? db.prepare(sql).bind(...params) : db.prepare(sql));
  return {
    all: async <T>(sql: string, ...params: unknown[]) => (await statement(sql, params).all<T>()).results,
    first: async <T>(sql: string, ...params: unknown[]) => (await statement(sql, params).first<T>()) ?? null,
  };
}
