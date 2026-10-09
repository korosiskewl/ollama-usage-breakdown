// In-browser Relay backend for the static preview build (GitHub Pages).
// Runs the exact same Hono app as the Cloudflare Worker against SQLite compiled to WebAssembly,
// persisted to IndexedDB. Everything stays on this device; nothing is sent anywhere.
import initSqlJs, { type Database } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { createApp } from '../../server/app';
import type { Env } from '../../server/env';
import { SqlJsD1 } from '../../server/sqljs-d1';

const migrations = import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const IDB_NAME = 'relay-preview';
const IDB_STORE = 'kv';
const DB_KEY = 'db';
const SESSION_KEY = 'relay.preview.session';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<Uint8Array | undefined> {
  try {
    const d = await idb();
    return await new Promise((resolve, reject) => {
      const r = d.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
      r.onsuccess = () => resolve(r.result as Uint8Array | undefined);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return undefined;
  }
}

async function idbPut(key: string, value: Uint8Array): Promise<void> {
  try {
    const d = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* private mode: data lives for this tab only */
  }
}

function applyMigrations(raw: Database) {
  raw.run('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
  const done = new Set<string>();
  const res = raw.exec('SELECT name FROM _migrations');
  for (const row of res[0]?.values ?? []) done.add(String(row[0]));
  for (const path of Object.keys(migrations).sort()) {
    const name = path.split('/').pop()!;
    if (done.has(name)) continue;
    raw.exec('BEGIN');
    try {
      raw.exec(migrations[path]);
      raw.run('INSERT INTO _migrations (name) VALUES (?)', [name]);
      raw.exec('COMMIT');
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
  }
}

interface Runtime {
  app: ReturnType<typeof createApp>;
  env: Env;
  db: SqlJsD1;
}

let boot: Promise<Runtime> | null = null;
let saveTimer: number | undefined;

function getRuntime(): Promise<Runtime> {
  return (boot ??= (async () => {
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });
    const saved = await idbGet(DB_KEY);
    const raw = saved ? new SQL.Database(saved) : new SQL.Database();
    applyMigrations(raw);
    const db = new SqlJsD1(raw);
    const env: Env = {
      DB: db,
      HEADER_SESSIONS: 'true',
      FIRST_USER_ADMIN: 'true',
      DISABLE_RATE_LIMITS: 'true',
    };
    const app = createApp();
    const rt = { app, env, db };
    if (!saved) {
      const { seed } = await import('./seed');
      await seed((req) => app.fetch(req, env), db);
      // Seeding signs demo users in; start the visitor signed out.
      localStorage.removeItem(SESSION_KEY);
      persistNow(rt);
    }
    window.addEventListener('pagehide', () => persistNow(rt));
    return rt;
  })());
}

function persistNow(rt: Runtime) {
  window.clearTimeout(saveTimer);
  const bytes = rt.db.raw.export();
  // export() re-opens the database and resets pragmas.
  rt.db.raw.run('PRAGMA foreign_keys = ON');
  void idbPut(DB_KEY, bytes);
}

function schedulePersist(rt: Runtime) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => persistNow(rt), 250);
}

// Serialise requests: sql.js is synchronous and the app expects D1's one-statement-at-a-time semantics.
let queue: Promise<unknown> = Promise.resolve();

export function previewFetch(req: Request): Promise<Response> {
  const run = async () => {
    const rt = await getRuntime();
    const headers = new Headers(req.headers);
    let token: string | null = null;
    try {
      token = localStorage.getItem(SESSION_KEY);
    } catch {
      /* storage blocked */
    }
    if (token) headers.set('x-relay-session', token);
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
    const res = await rt.app.fetch(new Request(req.url, { method: req.method, headers, body }), rt.env);
    const next = res.headers.get('x-relay-set-session');
    if (next !== null) {
      try {
        if (next) localStorage.setItem(SESSION_KEY, next);
        else localStorage.removeItem(SESSION_KEY);
      } catch {
        /* storage blocked */
      }
    }
    if (req.method !== 'GET') schedulePersist(rt);
    return res;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/** Wipe the local preview database and reload with fresh demo content. */
export async function resetPreview() {
  try {
    localStorage.removeItem(SESSION_KEY);
    const d = await idb();
    await new Promise<void>((resolve) => {
      const tx = d.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } finally {
    location.hash = '#/';
    location.reload();
  }
}
