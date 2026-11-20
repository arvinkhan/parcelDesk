import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPool, migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
import { provisionShop, seed } from '../src/setup.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a dedicated test database.');
const pool = createPool(process.env.TEST_DATABASE_URL);
const { app, store } = createApp(pool, { secret: 'parceldesk-test-only-long-credential' });
let server: Server;
let base: string;
let dispatch: string;
let ravi: string;
let neha: string;
let outsider: string;
let riderA: string;
let riderB: string;

async function request(path: string, session = '', body?: object, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + path, {
    method, headers: { ...(session ? { Cookie: session } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
async function login(email: string, password = 'ParcelDeskDemo!') {
  const response = await request('/login', '', { email, password });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.cookie);
  return response.cookie;
}
async function order(cod = true, reference = 'T-' + randomUUID().slice(0, 12)) {
  const response = await request('/shipments', dispatch, {
    reference, customer: 'Demo Customer', address: '100 Demo Street',
    description: 'Test parcel', payment: cod ? 'cod' : 'prepaid', cod_paise: cod ? 75000 : 0,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.id as string;
}
const action = (id: string, session: string, body: object) => request('/shipments/' + id + '/actions', session, body);
const deliver = (assignment_id: string) => ({ kind: 'attempt', assignment_id, outcome: 'delivered', submission_id: randomUUID() });
async function assignAndPickup(id: string, rider_id = riderA, rider = ravi) {
  const assigned = await action(id, dispatch, { kind: 'assign', rider_id });
  assert.equal(assigned.status, 200);
  const assignment_id: string = assigned.body.assignment_id;
  assert.equal((await action(id, rider, { kind: 'pickup', assignment_id })).status, 200);
  return assignment_id;
}

before(async () => {
  await migrate(pool);
  await seed(pool);
  const email = 'outside-' + randomUUID() + '@parceldesk.demo';
  await provisionShop(pool, { SHOP_NAME: 'Other Shop', DISPATCHER_NAME: 'Outside', DISPATCHER_EMAIL: email,
    DISPATCHER_PASSWORD: 'ParcelDeskDemo!' });
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api';
  [dispatch, ravi, neha, outsider] = await Promise.all([
    login('dispatch@parceldesk.demo'), login('ravi@parceldesk.demo'), login('neha@parceldesk.demo'), login(email),
  ]);
  riderA = (await request('/me', ravi)).body.id;
  riderB = (await request('/me', neha)).body.id;
});
after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close();
  await pool.end();
});

test('requires a session, enforces roles, and scopes private records to each shop', async () => {
  assert.equal((await request('/shipments')).status, 401);
  const id = await order();
  assert.equal((await request('/shipments/' + id, outsider)).status, 404);
  assert.equal((await action(id, outsider, { kind: 'assign', rider_id: riderA })).status, 404);
  assert.equal((await request('/cash', ravi)).status, 403);
  assert.equal((await action(id, ravi, { kind: 'assign', rider_id: riderB })).status, 403);
  assert.equal((await request('/shipments/' + id, ravi)).status, 404);
  assert.equal((await action(id, dispatch, { kind: 'pickup', assignment_id: randomUUID() })).status, 403);
});

test('concurrent dispatch attempts leave exactly one active assignment', async () => {
  const id = await order();
  const results = await Promise.all([
    action(id, dispatch, { kind: 'assign', rider_id: riderA }),
    action(id, dispatch, { kind: 'assign', rider_id: riderB }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal((await pool.query('SELECT id FROM assignments WHERE shipment_id=$1 AND ended_at IS NULL', [id])).rowCount, 1);
});

test('the dispatcher can add a rider and replace an assignment before pickup', async () => {
  const email = 'rider-' + randomUUID() + '@parceldesk.demo';
  const credentials = { name: 'New Rider', email, password: 'NewDemoRider123!' };
  assert.equal((await request('/riders', ravi, credentials)).status, 403);
  const created = await request('/riders', dispatch, credentials);
  assert.equal(created.status, 201);
  assert.equal((await request('/riders', dispatch, credentials)).status, 409);
  const newRider = await login(email, credentials.password);
  const id = await order();
  const assigned = await action(id, dispatch, { kind: 'assign', rider_id: riderA });
  assert.equal(assigned.status, 200);
  assert.equal((await action(id, dispatch, { kind: 'unassign' })).status, 200);
  assert.equal((await action(id, ravi, { kind: 'pickup', assignment_id: assigned.body.assignment_id })).status, 409);
  await assignAndPickup(id, created.body.id, newRider);
  assert.equal((await action(id, dispatch, { kind: 'unassign' })).status, 409);
});

test('return confirmation releases custody and a stale rider cannot finish a reassigned shipment', async () => {
  const id = await order();
  const assignmentA = await assignAndPickup(id);
  const failed = { kind: 'attempt', assignment_id: assignmentA, outcome: 'failed', reason: 'Customer unavailable', submission_id: randomUUID() };
  assert.equal((await action(id, ravi, failed)).status, 200);
  assert.equal((await action(id, dispatch, { kind: 'request_return' })).status, 200);
  assert.equal((await action(id, dispatch, { kind: 'assign', rider_id: riderB })).status, 409);
  assert.equal((await action(id, dispatch, { kind: 'confirm_return' })).status, 200);
  const assignmentB = await assignAndPickup(id, riderB, neha);
  assert.equal((await action(id, ravi, deliver(assignmentA))).status, 409);
  assert.equal((await action(id, ravi, failed)).body.replayed, true);
  assert.equal((await action(id, neha, deliver(assignmentB))).status, 200);
  const detail = (await request('/shipments/' + id, dispatch)).body;
  assert.equal(detail.status, 'delivered');
  assert.deepEqual(detail.attempts.map((attempt: { outcome: string }) => attempt.outcome).sort(), ['delivered', 'failed']);
  const cash = (await pool.query('SELECT rider_id,amount_paise FROM cash_entries WHERE shipment_id=$1', [id])).rows;
  assert.deepEqual(cash, [{ rider_id: riderB, amount_paise: 75000 }]);
});

test('a new assignment to the same rider still rejects delayed actions from the old assignment', async () => {
  const id = await order();
  const old = await assignAndPickup(id);
  assert.equal((await action(id, dispatch, { kind: 'request_return' })).status, 200);
  assert.equal((await action(id, dispatch, { kind: 'confirm_return' })).status, 200);
  const current = await assignAndPickup(id);
  assert.notEqual(old, current);
  assert.equal((await action(id, ravi, deliver(old))).status, 409);
  assert.equal((await action(id, ravi, deliver(current))).status, 200);
});

test('concurrent retries produce one attempt and one cash entry', async () => {
  const id = await order();
  const payload = deliver(await assignAndPickup(id));
  const attempts = await Promise.all([action(id, ravi, payload), action(id, ravi, payload)]);
  assert.deepEqual(attempts.map(result => result.status), [200, 200]);
  assert.equal(attempts[0].body.attempt_id, attempts[1].body.attempt_id);
  assert.equal(attempts.filter(result => result.body.replayed).length, 1);
  assert.equal((await action(id, ravi, { ...payload, outcome: 'failed', reason: 'Different payload' })).status, 409);
  const entries = (await pool.query('SELECT amount_paise FROM cash_entries WHERE shipment_id=$1', [id])).rows;
  assert.deepEqual(entries, [{ amount_paise: 75000 }]);
});

test('prepaid deliveries leave no cash entry and tracking exposes only public fields', async () => {
  const id = await order(false);
  assert.equal((await action(id, ravi, deliver(await assignAndPickup(id)))).status, 200);
  assert.equal((await pool.query('SELECT id FROM cash_entries WHERE shipment_id=$1', [id])).rowCount, 0);
  const shipment = (await request('/shipments/' + id, dispatch)).body;
  const tracking = await request('/track/' + shipment.tracking_token);
  assert.equal(tracking.status, 200);
  assert.equal(tracking.body.status, 'delivered');
  assert.deepEqual(Object.keys(tracking.body).sort(), ['reference', 'shop', 'status', 'updated_at']);
});

test('concurrent settlement submissions settle each entry once and retain its variance', async () => {
  const id = await order();
  assert.equal((await action(id, ravi, deliver(await assignAndPickup(id)))).status, 200);
  const entry = (await pool.query('SELECT id FROM cash_entries WHERE shipment_id=$1', [id])).rows[0].id;
  const draft = { rider_id: riderA, entry_ids: [entry], received_paise: 65000, submission_id: randomUUID() };
  assert.equal((await request('/settlements', dispatch, draft)).status, 400);
  const payload = { ...draft, note: 'Rider reports ₹100 still due' };
  const results = await Promise.all([
    request('/settlements', dispatch, payload),
    request('/settlements', dispatch, { ...payload, submission_id: randomUUID() }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const winner = results.find(result => result.status === 200)!;
  const replay = await request('/settlements', dispatch, { ...payload, submission_id: winner.body.submission_id });
  assert.equal(replay.body.id, winner.body.id);
  assert.equal(winner.body.expected_paise - winner.body.received_paise, 10000);
  const cash = (await request('/cash', dispatch)).body;
  assert.equal(cash.entries.some((row: { id: string }) => row.id === entry), false);
});

test('validates input and rejects duplicate order references', async () => {
  const reference = 'UNIQUE-' + randomUUID().slice(0, 8);
  await order(true, reference);
  const body = { reference: reference.toLowerCase(), customer: 'Example', address: 'Example street',
    description: 'Example parcel', payment: 'cod', cod_paise: 500 };
  assert.equal((await request('/shipments', dispatch, body)).status, 409);
  assert.equal((await request('/shipments', dispatch, { ...body, cod_paise: 123.45 })).status, 400);
  assert.equal((await request('/shipments?before=garbage', dispatch)).status, 400);
});

test('paginates shipments without dropping rows with tied timestamps', async () => {
  const owner = (await request('/me', dispatch)).body;
  const prefix = 'PAGE-' + randomUUID().slice(0, 8) + '-';
  await pool.query(
    `INSERT INTO shipments (shop_id,reference,customer,address,description,payment,cod_paise,created_at)
     SELECT $1, $2 || n, 'Example', 'Example street', 'Test parcel', 'prepaid', 0, now()
     FROM generate_series(1, 53) AS n`, [owner.shop_id, prefix]);
  const first = (await request('/shipments', dispatch)).body;
  assert.equal(first.items.length, 50);
  assert.ok(first.next);
  const secondResponse = await request('/shipments?before=' + encodeURIComponent(first.next), dispatch);
  assert.equal(secondResponse.status, 200);
  const items = [...first.items, ...secondResponse.body.items];
  assert.equal(items.filter(item => item.reference.startsWith(prefix)).length, 53);
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
});

test('logout invalidates the server-side session', async () => {
  const cookie = await login('ravi@parceldesk.demo');
  assert.equal((await request('/logout', cookie, undefined, 'POST')).status, 204);
  assert.equal((await request('/me', cookie)).status, 401);
});
