// Cloudflare Workers entry point. Static assets (the built SPA) are served by Workers Static Assets;
// only /api/* reaches this code (see "run_worker_first" in wrangler.jsonc).
import { createApp } from './app';

const app = createApp();

export default {
  fetch: app.fetch,
  // Housekeeping: purge expired sessions and stale rate-limit windows. Enable with a cron trigger.
  async scheduled(_event: unknown, env: { DB: import('./db').D1Like }) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 24 * 3600 * 1000),
    ]);
  },
};
