import { Hono } from 'hono';
import type { AppEnv } from '../env';

// TODO: implemented by the backend workstream (see docs/API.md).
export const settingsRoutes = new Hono<AppEnv>();
