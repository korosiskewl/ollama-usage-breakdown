// Thin JSON client for the Relay API. In the GitHub Pages preview build the same server code runs
// in the browser (see src/preview/runtime.ts) and requests are routed to it instead of the network.
import type { ApiErrorBody } from '../../shared/types';

export const PREVIEW = import.meta.env.VITE_RELAY_MODE === 'preview';

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

async function send(req: Request): Promise<Response> {
  // Compared against import.meta.env directly so production builds drop the preview runtime entirely.
  if (import.meta.env.VITE_RELAY_MODE === 'preview') {
    const { previewFetch } = await import('../preview/runtime');
    return previewFetch(req);
  }
  return fetch(req);
}

type Query = Record<string, string | number | boolean | null | undefined>;

function url(path: string, query?: Query): string {
  const base = PREVIEW ? 'https://preview.relay.local' : location.origin;
  const u = new URL(`/api${path}`, base);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

async function request<T>(method: string, path: string, opts: { query?: Query; json?: unknown; raw?: Blob; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers['x-relay-client'] = '1';
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.raw) {
    headers['content-type'] = opts.raw.type || 'application/octet-stream';
    body = opts.raw;
  }
  let res: Response;
  try {
    res = await send(new Request(url(path, opts.query), { method, headers, body, credentials: 'same-origin', signal: opts.signal }));
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiRequestError(0, 'network', navigator.onLine ? 'Couldn’t reach Relay. Check your connection and try again.' : 'You’re offline. Reconnect and try again.');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiRequestError(res.status, err?.code ?? 'http_' + res.status, err?.message ?? 'Something went wrong.', err?.fields ?? {});
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, json: unknown = {}) => request<T>('POST', path, { json }),
  patch: <T>(path: string, json: unknown) => request<T>('PATCH', path, { json }),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, file: Blob) => request<T>('POST', path, { raw: file }),
};

/** Resolve an API media URL into something an <img> can load (object URL in preview mode). */
const mediaCache = new Map<string, Promise<string>>();
export function resolveMedia(src: string): Promise<string> {
  if (import.meta.env.VITE_RELAY_MODE !== 'preview') return Promise.resolve(src);
  let p = mediaCache.get(src);
  if (!p) {
    p = (async () => {
      const res = await send(new Request(new URL(src, 'https://preview.relay.local').toString()));
      if (!res.ok) throw new Error('media');
      return URL.createObjectURL(await res.blob());
    })();
    mediaCache.set(src, p);
  }
  return p;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  return 'Something went wrong.';
}
