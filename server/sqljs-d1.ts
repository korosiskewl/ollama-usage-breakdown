// D1-compatible adapter over sql.js (SQLite compiled to WebAssembly).
// Used by the test suite and by the in-browser preview build (GitHub Pages).
import type { Database, SqlValue } from 'sql.js';
import type { D1Like, D1Result, D1Stmt } from './db';

function toSql(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v as SqlValue;
}

class Stmt implements D1Stmt {
  constructor(private db: Database, private sql: string, private params: SqlValue[] = []) {}

  bind(...values: unknown[]): D1Stmt {
    return new Stmt(this.db, this.sql, values.map(toSql));
  }

  rows<T>(): T[] {
    const st = this.db.prepare(this.sql);
    try {
      st.bind(this.params);
      const out: T[] = [];
      while (st.step()) out.push(st.getAsObject() as T);
      return out;
    } finally {
      st.free();
    }
  }

  async first<T>(): Promise<T | null> {
    return this.rows<T>()[0] ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return { results: this.rows<T>(), meta: { changes: 0 } };
  }

  runSync(): D1Result {
    this.rows();
    return { results: [], meta: { changes: this.db.getRowsModified() } };
  }

  async run(): Promise<D1Result> {
    return this.runSync();
  }
}

export class SqlJsD1 implements D1Like {
  constructor(public readonly raw: Database) {
    raw.run('PRAGMA foreign_keys = ON');
  }

  prepare(sql: string): D1Stmt {
    return new Stmt(this.raw, sql);
  }

  async batch(stmts: D1Stmt[]): Promise<D1Result[]> {
    // D1 batches are atomic; mirror that with a transaction.
    this.raw.run('BEGIN');
    try {
      const out: D1Result[] = [];
      for (const s of stmts) {
        const st = s as Stmt;
        const isRead = /^\s*select/i.test((st as unknown as { sql: string }).sql);
        out.push(isRead ? { results: st.rows(), meta: { changes: 0 } } : st.runSync());
      }
      this.raw.run('COMMIT');
      return out;
    } catch (e) {
      this.raw.run('ROLLBACK');
      throw e;
    }
  }

  exec(sql: string) {
    this.raw.exec(sql);
  }
}
