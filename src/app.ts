import { resolve } from 'node:path';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import type { Pool } from 'pg';
import { z } from 'zod';
import { addShipment, applyAction, HttpError, settleCash, type Role, type User } from './operations.js';
import { hashPassword, verifyPassword } from './security.js';

declare module 'express-session' {
  interface SessionData { userId?: string }
}

const uuid = z.uuid().transform(value => value.toLowerCase());
const paise = z.number().int().min(0).max(2147483647);
const note = z.string().trim().min(1).max(500);
const orderSchema = z.object({
  reference: z.string().trim().min(1).max(32).transform(value => value.toUpperCase()),
  customer: z.string().trim().min(1).max(100),
  address: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(200),
  payment: z.enum(['cod', 'prepaid']),
  cod_paise: paise,
}).refine(value => value.payment === 'cod' ? value.cod_paise > 0 : value.cod_paise === 0,
  { message: 'Enter a positive COD amount, or choose prepaid with zero due.' });
const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assign'), rider_id: uuid }),
  z.object({ kind: z.enum(['unassign', 'retry', 'request_return', 'confirm_return']) }),
  z.object({ kind: z.literal('pickup'), assignment_id: uuid }),
  z.object({ kind: z.literal('attempt'), assignment_id: uuid, submission_id: uuid, outcome: z.enum(['delivered', 'failed']), reason: note.optional() }),
]);
const settlementSchema = z.object({
  rider_id: uuid, submission_id: uuid, entry_ids: z.array(uuid).min(1).max(200),
  received_paise: paise, note: note.optional(),
});

export function createApp(pool: Pool, options: {
  secret: string; secureCookies?: boolean; trustProxy?: boolean; demoMode?: boolean;
}) {
  const app = express();
  const store = new (pgSession(session))({ pool, tableName: 'user_sessions', pruneSessionInterval: 15 * 60 });
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        origin !== req.protocol + '://' + req.get('host')) {
      return next(new HttpError(403, 'Origin does not match this application.'));
    }
    next();
  });
  app.use('/api', express.json({ limit: '32kb' }));

  app.get('/api/config', (_req, res) => res.json({ demo_mode: Boolean(options.demoMode) }));
  app.get('/api/track/:token', async (req, res) => {
    const token = uuid.parse(req.params.token);
    const shipment = (await pool.query(
      `SELECT s.reference,s.status,s.updated_at,sh.name AS shop FROM shipments s
       JOIN shops sh ON sh.id=s.shop_id WHERE s.tracking_token=$1`, [token])).rows[0];
    if (!shipment) throw new HttpError(404, 'Tracking link not found.');
    res.json(shipment);
  });

  const cookieName = 'parceldesk.sid';
  app.use('/api', session({
    name: cookieName, secret: options.secret, store, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: Boolean(options.secureCookies), maxAge: 8 * 60 * 60 * 1000 },
  }));

  app.post('/api/login', async (req, res) => {
    const input = z.object({ email: z.email().max(254), password: z.string().min(1).max(128) }).parse(req.body);
    const result = await pool.query<User & { password_hash: string }>(
      'SELECT id,shop_id,name,role,password_hash FROM users WHERE email=$1', [input.email.toLowerCase()]);
    const user = result.rows[0];
    if (!(await verifyPassword(input.password, user?.password_hash))) throw new HttpError(401, 'Email or password is incorrect.');
    await new Promise<void>((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.userId = user.id;
    await new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    res.json({ id: user.id, name: user.name, role: user.role });
  });
  app.post('/api/logout', (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie(cookieName, { httpOnly: true, sameSite: 'lax', secure: Boolean(options.secureCookies) });
      res.sendStatus(204);
    });
  });

  function requireUser(role?: Role): RequestHandler {
    return async (req, res, next) => {
      const userId = req.session.userId;
      if (!userId) throw new HttpError(401, 'Sign in to continue.');
      const user = (await pool.query<User & { shop: string }>(
        'SELECT u.id,u.shop_id,u.name,u.role,s.name AS shop FROM users u JOIN shops s ON s.id=u.shop_id WHERE u.id=$1',
        [userId])).rows[0];
      if (!user) throw new HttpError(401, 'Sign in to continue.');
      if (role && user.role !== role) throw new HttpError(403, 'Your role cannot perform this action.');
      res.locals.user = user;
      next();
    };
  }

  app.get('/api/me', requireUser(), (_req, res) => res.json(res.locals.user));
  app.get('/api/riders', requireUser('dispatcher'), async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT u.id,u.name,
        (SELECT count(*)::int FROM assignments a WHERE a.rider_id=u.id AND a.ended_at IS NULL) AS active,
        (SELECT count(*)::int FROM cash_entries c WHERE c.rider_id=u.id AND c.settlement_id IS NULL) AS open_entries,
        (SELECT COALESCE(sum(c.amount_paise),0)::text FROM cash_entries c WHERE c.rider_id=u.id AND c.settlement_id IS NULL) AS open_paise
       FROM users u WHERE u.shop_id=$1 AND u.role='rider' ORDER BY u.name`, [res.locals.user.shop_id]);
    res.json(rows);
  });
  app.post('/api/riders', requireUser('dispatcher'), async (req, res) => {
    const input = z.object({
      name: z.string().trim().min(1).max(100), email: z.email().max(254),
      password: z.string().min(12).max(128),
    }).parse(req.body);
    const { rows } = await pool.query(
      `INSERT INTO users (shop_id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,'rider')
       ON CONFLICT (email) DO NOTHING RETURNING id,name`,
      [res.locals.user.shop_id, input.name, input.email.toLowerCase(), await hashPassword(input.password)]);
    if (!rows[0]) throw new HttpError(409, 'A user with this email already exists.');
    res.status(201).json(rows[0]);
  });
  app.get('/api/shipments', requireUser(), async (req, res) => {
    const user: User = res.locals.user;
    const params = z.object({ before: z.string().optional() }).parse(req.query);
    const cursor = params.before ? z.tuple([z.iso.datetime(), uuid]).parse(JSON.parse(Buffer.from(params.before, 'base64url').toString())) : null;
    const values: unknown[] = [user.shop_id];
    let where = 's.shop_id=$1';
    if (user.role === 'rider') {
      values.push(user.id);
      where += ' AND a.rider_id=$2';
    }
    if (cursor) {
      values.push(...cursor);
      where += ' AND (s.created_at,s.id) < ($' + (values.length - 1) + '::timestamptz,$' + values.length + '::uuid)';
    }
    const { rows } = await pool.query(
      `SELECT s.*,u.name AS rider,
        to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
       FROM shipments s LEFT JOIN assignments a ON a.shipment_id=s.id AND a.ended_at IS NULL
       LEFT JOIN users u ON u.id=a.rider_id WHERE ${where} ORDER BY s.created_at DESC,s.id DESC LIMIT 51`, values);
    const last = rows[49];
    const next = rows.length > 50 ? Buffer.from(JSON.stringify([last.cursor_time, last.id])).toString('base64url') : null;
    res.json({ items: rows.slice(0, 50).map(({ cursor_time, ...row }) => row), next });
  });
  app.get('/api/summary', requireUser('dispatcher'), async (_req, res) => {
    const { shop_id } = res.locals.user;
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status IN ('assigned','out_for_delivery','return_requested'))::int AS active,
        count(*) FILTER (WHERE status='failed')::int AS failed,
        count(*) FILTER (WHERE status='delivered')::int AS delivered,
        (SELECT COALESCE(sum(amount_paise),0)::text FROM cash_entries WHERE shop_id=$1 AND settlement_id IS NULL) AS open_paise
       FROM shipments WHERE shop_id=$1`, [shop_id]);
    res.json(rows[0]);
  });
  app.post('/api/shipments', requireUser('dispatcher'), async (req, res) => {
    res.status(201).json(await addShipment(pool, res.locals.user, orderSchema.parse(req.body)));
  });
  app.get('/api/shipments/:id', requireUser(), async (req, res) => {
    const id = uuid.parse(req.params.id);
    const user: User = res.locals.user;
    const query = user.role === 'rider' ? ' AND a.rider_id=$3' : '';
    const data = await pool.query(
      `SELECT s.*,a.id AS assignment_id,u.name AS rider FROM shipments s
       LEFT JOIN assignments a ON a.shipment_id=s.id AND a.ended_at IS NULL
       LEFT JOIN users u ON u.id=a.rider_id WHERE s.shop_id=$1 AND s.id=$2${query}`,
      user.role === 'rider' ? [user.shop_id, id, user.id] : [user.shop_id, id]);
    if (!data.rows[0]) throw new HttpError(404, 'Shipment not found.');
    const [events, attempts] = await Promise.all([
      pool.query('SELECT status, detail, created_at FROM shipment_events WHERE shipment_id=$1 ORDER BY id DESC LIMIT 50', [id]),
      pool.query(`SELECT d.outcome,d.reason,d.created_at,u.name AS rider FROM delivery_attempts d JOIN assignments a ON a.id=d.assignment_id
                  JOIN users u ON u.id=a.rider_id WHERE d.shipment_id=$1 ORDER BY d.created_at DESC LIMIT 50`, [id]),
    ]);
    res.json({ ...data.rows[0], events: events.rows, attempts: attempts.rows });
  });
  app.post('/api/shipments/:id/actions', requireUser(), async (req, res) => {
    const action = actionSchema.parse(req.body);
    if (action.kind === 'attempt' && (action.outcome === 'failed') !== Boolean(action.reason)) {
      throw new HttpError(400, 'Provide a reason for a failed attempt.');
    }
    res.json(await applyAction(pool, res.locals.user, uuid.parse(req.params.id), action));
  });
  app.get('/api/cash', requireUser('dispatcher'), async (_req, res) => {
    const { shop_id } = res.locals.user;
    const [entries, settlements] = await Promise.all([
      pool.query(`SELECT c.id,c.amount_paise,c.rider_id,u.name AS rider,s.reference,s.customer,c.created_at
                  FROM cash_entries c JOIN users u ON u.id=c.rider_id JOIN shipments s ON s.id=c.shipment_id
                  WHERE c.shop_id=$1 AND c.settlement_id IS NULL ORDER BY c.created_at DESC,c.id DESC`, [shop_id]),
      pool.query(`SELECT t.id,t.expected_paise,t.received_paise,t.note,t.created_at,u.name AS rider,
                    (SELECT array_agg(s.reference ORDER BY s.reference) FROM cash_entries e JOIN shipments s ON s.id=e.shipment_id WHERE e.settlement_id=t.id) AS references
                  FROM settlements t JOIN users u ON u.id=t.rider_id WHERE t.shop_id=$1
                  ORDER BY t.created_at DESC,t.id DESC LIMIT 50`, [shop_id]),
    ]);
    res.json({ entries: entries.rows, settlements: settlements.rows });
  });
  app.post('/api/settlements', requireUser('dispatcher'), async (req, res) => {
    res.json(await settleCash(pool, res.locals.user, settlementSchema.parse(req.body)));
  });

  app.use('/api', () => { throw new HttpError(404, 'Endpoint not found.'); });
  app.use(express.static(resolve('public')));
  app.get('/track/:token', (_req, res) => res.sendFile(resolve('public/index.html')));
  const handleError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues.map(issue => [issue.path.join('.'), issue.message].filter(Boolean).join(': ')).join(' ') });
    }
    if (error instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON or cursor.' });
    if (error.status === 413) return res.status(413).json({ error: 'Request body is too large.' });
    console.error('Request failed', error.code ?? error.name);
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  };
  app.use(handleError);
  return { app, store };
}
