import { createApp } from './app.js';
import { createPool, migrate } from './db.js';

const pool = createPool();
const secret = process.env.SESSION_SECRET;
if (!secret || secret.length < 24) throw new Error('Set SESSION_SECRET to at least 24 characters.');
await migrate(pool);
const { app, store } = createApp(pool, {
  secret, demoMode: process.env.DEMO_MODE === 'true', secureCookies: process.env.SECURE_COOKIES === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true',
});
const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, process.env.HOST ?? '0.0.0.0', () => console.log('ParcelDesk listening on port ' + port));

function close() {
  server.close(() => {
    store.close();
    void pool.end();
  });
}
process.once('SIGTERM', close);
process.once('SIGINT', close);
