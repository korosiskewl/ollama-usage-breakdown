# Setup & deployment

## Local development

```bash
npm install
npm test                 # API test suite (runs the real app against in-memory SQLite)
npm run typecheck

# Frontend + in-browser backend (no Cloudflare account needed):
VITE_RELAY_MODE=preview npm run dev

# Full stack on the Workers runtime (needs wrangler login only for remote resources):
cp .dev.vars.example .dev.vars
npx vite build
npm run db:migrate:local
npm run dev:worker       # http://localhost:8787
```

## GitHub Pages preview

1. Settings → Pages → Build and deployment → **Source: GitHub Actions**.
2. If this repository is a fork, open the **Actions** tab once and enable workflows.
3. Push to `main` (or run "Deploy preview to GitHub Pages" manually). The site appears at
   `https://<user>.github.io/<repo>/`.

## Cloudflare (the real, multi-user Relay)

Relay 3.0 is a **separate Worker (`relay3`) with a new D1 database**, so it cannot touch Relay 2.0 or its data.

```bash
npx wrangler login
npx wrangler d1 create relay                 # copy database_id into wrangler.jsonc
npx wrangler r2 bucket create relay-media
npm run db:migrate:remote
npx wrangler secret put ANTHROPIC_API_KEY    # optional — AI stays off without it
# set ADMIN_HANDLES in wrangler.jsonc to your handle, then:
npm run deploy
```

Or use the manual **Deploy Worker** workflow after adding `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
repository secrets. Costs: Workers, D1 and R2 all have free tiers that comfortably cover a small community.

Optional: add a cron trigger (`"triggers": { "crons": ["17 3 * * *"] }`) to purge expired sessions and old
rate-limit rows via the Worker's `scheduled` handler.

## Environment

| Name | Kind | Purpose |
|---|---|---|
| `DB` | D1 binding | primary database |
| `MEDIA` | R2 binding | avatars (optional; falls back to D1 blobs) |
| `ADMIN_HANDLES` | var | comma-separated handles granted admin on signup/login |
| `AI_MODEL` | var | Anthropic model id for the assistant (default `claude-opus-5-5`) |
| `ANTHROPIC_API_KEY` | secret | enables the optional AI assistant |
| `COOKIE_SECURE` | var | `false` only for plain-http local dev |
| `FIRST_USER_ADMIN`, `HEADER_SESSIONS`, `DISABLE_RATE_LIMITS` | var | **preview/test only — never set in production** |

## Migrations

Migrations are plain SQL files in `migrations/`, applied in filename order by `wrangler d1 migrations apply`.
Never edit an applied migration; add a new numbered file. Do not run destructive migrations against production
without a backup (`wrangler d1 export relay --remote --output backup.sql`).
