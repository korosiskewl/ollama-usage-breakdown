import { Hono } from 'hono';
import type { AppEnv } from './env';
import { ApiError } from './http';
import { csrfMiddleware, sessionMiddleware } from './auth';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { postRoutes } from './routes/posts';
import { feedRoutes } from './routes/feed';
import { searchRoutes } from './routes/search';
import { notificationRoutes } from './routes/notifications';
import { messageRoutes } from './routes/messages';
import { moderationRoutes } from './routes/moderation';
import { collectionRoutes } from './routes/collections';
import { settingsRoutes } from './routes/settings';
import { aiRoutes } from './routes/ai';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', c.res.headers.get('Cache-Control') ?? 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });
  app.use('/api/*', csrfMiddleware);
  app.use('/api/*', sessionMiddleware);

  app.get('/api/health', (c) => c.json({ ok: true, version: '3.0.0-alpha.1' }));

  const api = new Hono<AppEnv>();
  api.route('/', authRoutes);
  api.route('/', userRoutes);
  api.route('/', postRoutes);
  api.route('/', feedRoutes);
  api.route('/', searchRoutes);
  api.route('/', notificationRoutes);
  api.route('/', messageRoutes);
  api.route('/', moderationRoutes);
  api.route('/', collectionRoutes);
  api.route('/', settingsRoutes);
  api.route('/', aiRoutes);
  app.route('/api', api);

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } }, err.status);
    }
    console.error('Unhandled error', err);
    return c.json({ error: { code: 'internal', message: 'Something went wrong on our side.' } }, 500);
  });

  return app;
}

export type RelayApp = ReturnType<typeof createApp>;
