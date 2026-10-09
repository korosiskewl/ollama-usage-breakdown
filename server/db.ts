// Minimal structural subset of Cloudflare's D1 API that Relay relies on.
// Production uses a real D1 binding; tests and the in-browser preview use server/sqljs-d1.ts.

export interface D1Result<T = unknown> {
  results: T[];
  meta: { changes: number; last_row_id?: number };
}

export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(stmts: D1Stmt[]): Promise<D1Result[]>;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = 0;
let lastRand: number[] = [];

/** ULID-style 26-char id: 10 chars of millisecond time + 16 random chars, monotonic within one isolate. */
export function newId(now = Date.now()): string {
  let rand: number[];
  if (now === lastTime && lastRand.length) {
    rand = lastRand.slice();
    for (let i = rand.length - 1; i >= 0; i--) {
      if (rand[i] < 31) { rand[i]++; break; }
      rand[i] = 0;
    }
  } else {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    rand = Array.from(bytes, (b) => b & 31);
  }
  lastTime = now;
  lastRand = rand;
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + rand.map((r) => CROCKFORD[r]).join('');
}

export const iso = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms).toISOString());
export const isoReq = (ms: number): string => new Date(ms).toISOString();

/** Build "?, ?, ?" for an IN clause. */
export const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');
