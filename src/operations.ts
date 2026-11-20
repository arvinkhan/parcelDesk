import type { Pool, PoolClient } from 'pg';
import { transaction } from './db.js';

export type Role = 'dispatcher' | 'rider';
export type User = { id: string; shop_id: string; name: string; role: Role };
export type Status = 'ready' | 'assigned' | 'out_for_delivery' | 'failed' | 'return_requested' | 'returned' | 'delivered';
export type Action =
  | { kind: 'assign'; rider_id: string }
  | { kind: 'pickup'; assignment_id: string }
  | { kind: 'unassign' | 'retry' | 'request_return' | 'confirm_return' }
  | { kind: 'attempt'; assignment_id: string; submission_id: string; outcome: 'delivered' | 'failed'; reason?: string };

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Shipment = { status: Status; cod_paise: number; payment: 'prepaid' | 'cod' };
type Assignment = { id: string; rider_id: string; name: string };

export async function addShipment(pool: Pool | PoolClient, user: User, input: {
  reference: string; customer: string; address: string; description: string;
  payment: 'prepaid' | 'cod'; cod_paise: number;
}) {
  return transaction(pool, async client => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO shipments (shop_id, reference, customer, address, description, payment, cod_paise)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (shop_id, reference) DO NOTHING RETURNING id`,
      [user.shop_id, input.reference, input.customer, input.address, input.description, input.payment, input.cod_paise]);
    const shipment = result.rows[0];
    if (!shipment) throw new HttpError(409, 'That order reference already exists.');
    await addEvent(client, user, shipment.id, 'ready', 'Order created');
    return shipment;
  });
}

function addEvent(client: PoolClient, user: User, id: string, status: Status, detail: string) {
  return client.query(
    'INSERT INTO shipment_events (shop_id, shipment_id, actor_id, status, detail) VALUES ($1,$2,$3,$4,$5)',
    [user.shop_id, id, user.id, status, detail]);
}

function requireState(current: Status, allowed: Status[]) {
  if (!allowed.includes(current)) throw new HttpError(409, 'This action is unavailable in the current shipment state.');
}

export async function applyAction(pool: Pool | PoolClient, user: User, id: string, action: Action) {
  const riderAction = action.kind === 'pickup' || action.kind === 'attempt';
  if (user.role !== (riderAction ? 'rider' : 'dispatcher')) throw new HttpError(403, 'Your role cannot perform this action.');

  return transaction(pool, async client => {
    const shipment = (await client.query<Shipment>(
      'SELECT status, cod_paise, payment FROM shipments WHERE shop_id=$1 AND id=$2 FOR UPDATE',
      [user.shop_id, id])).rows[0];
    if (!shipment) throw new HttpError(404, 'Shipment not found.');

    if (action.kind === 'attempt') {
      const previous = (await client.query(
        `SELECT d.id, d.outcome, d.reason, d.assignment_id, a.rider_id FROM delivery_attempts d
         JOIN assignments a ON a.id=d.assignment_id WHERE d.shipment_id=$1 AND d.submission_id=$2`,
        [id, action.submission_id])).rows[0];
      if (previous) {
        if (previous.rider_id !== user.id || previous.assignment_id !== action.assignment_id || previous.outcome !== action.outcome ||
            previous.reason !== (action.reason ?? null)) {
          throw new HttpError(409, 'That submission ID was already used for a different request.');
        }
        return { attempt_id: previous.id, outcome: previous.outcome, replayed: true };
      }
    }

    const assignment = (await client.query<Assignment>(
      `SELECT a.id, a.rider_id, u.name FROM assignments a JOIN users u ON u.id=a.rider_id
       WHERE a.shipment_id=$1 AND a.ended_at IS NULL`, [id])).rows[0];
    if ((action.kind === 'pickup' || action.kind === 'attempt') &&
        (assignment?.rider_id !== user.id || assignment.id !== action.assignment_id)) {
      throw new HttpError(409, 'You no longer hold that assignment.');
    }

    let status: Status;
    let detail: string;
    let attemptId: string | undefined;
    let assignmentId: string | undefined;
    switch (action.kind) {
      case 'assign': {
        requireState(shipment.status, ['ready', 'returned']);
        const rider = (await client.query<{ name: string }>(
          "SELECT name FROM users WHERE shop_id=$1 AND id=$2 AND role='rider'", [user.shop_id, action.rider_id])).rows[0];
        if (!rider) throw new HttpError(404, 'Rider not found.');
        const result = await client.query<{ id: string }>(
          'INSERT INTO assignments (shop_id, shipment_id, rider_id) VALUES ($1,$2,$3) RETURNING id', [user.shop_id, id, action.rider_id]);
        assignmentId = result.rows[0].id;
        status = 'assigned';
        detail = 'Assigned to ' + rider.name;
        break;
      }
      case 'pickup':
        requireState(shipment.status, ['assigned']);
        await client.query('UPDATE assignments SET picked_up_at=now() WHERE id=$1', [assignment.id]);
        status = 'out_for_delivery';
        detail = 'Picked up by ' + user.name;
        break;
      case 'unassign':
        requireState(shipment.status, ['assigned']);
        await client.query('UPDATE assignments SET ended_at=now() WHERE id=$1', [assignment.id]);
        status = 'ready';
        detail = 'Assignment removed before pickup';
        break;
      case 'retry':
        requireState(shipment.status, ['failed']);
        status = 'out_for_delivery';
        detail = 'Delivery reattempt approved';
        break;
      case 'request_return':
        requireState(shipment.status, ['failed', 'out_for_delivery']);
        status = 'return_requested';
        detail = 'Return to shop requested';
        break;
      case 'confirm_return':
        requireState(shipment.status, ['return_requested']);
        await client.query('UPDATE assignments SET ended_at=now() WHERE id=$1', [assignment.id]);
        status = 'returned';
        detail = 'Shop confirmed parcel return';
        break;
      case 'attempt': {
        requireState(shipment.status, ['out_for_delivery']);
        const result = await client.query<{ id: string }>(
          `INSERT INTO delivery_attempts (shop_id, shipment_id, assignment_id, submission_id, outcome, reason)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [user.shop_id, id, assignment.id, action.submission_id, action.outcome, action.reason ?? null]);
        attemptId = result.rows[0].id;
        status = action.outcome;
        detail = status === 'failed' ? 'Delivery attempt failed' : 'Delivered by ' + user.name;
        if (status === 'delivered') {
          await client.query('UPDATE assignments SET ended_at=now() WHERE id=$1', [assignment.id]);
          if (shipment.payment === 'cod') {
            await client.query(
              'INSERT INTO cash_entries (shop_id, shipment_id, assignment_id, rider_id, amount_paise) VALUES ($1,$2,$3,$4,$5)',
              [user.shop_id, id, assignment.id, user.id, shipment.cod_paise]);
          }
        }
        break;
      }
    }
    await client.query('UPDATE shipments SET status=$2, updated_at=now() WHERE id=$1', [id, status]);
    await addEvent(client, user, id, status, detail);
    return attemptId ? { attempt_id: attemptId, outcome: status, replayed: false } : { status, assignment_id: assignmentId };
  });
}

export async function settleCash(pool: Pool | PoolClient, user: User, input: {
  rider_id: string; submission_id: string; entry_ids: string[]; received_paise: number; note?: string;
}) {
  return transaction(pool, async client => {
    const rider = (await client.query(
      "SELECT id FROM users WHERE shop_id=$1 AND id=$2 AND role='rider' FOR NO KEY UPDATE",
      [user.shop_id, input.rider_id])).rows[0];
    if (!rider) throw new HttpError(404, 'Rider not found.');
    const previous = (await client.query(
      'SELECT * FROM settlements WHERE shop_id=$1 AND submission_id=$2', [user.shop_id, input.submission_id])).rows[0];
    const entryIds = [...new Set(input.entry_ids)].sort();
    if (previous) {
      const entries = await client.query<{ id: string }>('SELECT id FROM cash_entries WHERE settlement_id=$1 ORDER BY id', [previous.id]);
      if (previous.rider_id !== rider.id || previous.received_paise !== input.received_paise ||
          previous.note !== (input.note ?? null) || entries.rows.map(row => row.id).join() !== entryIds.join()) {
        throw new HttpError(409, 'That settlement request ID was already used.');
      }
      return previous;
    }
    const entries = await client.query<{ id: string; amount_paise: number }>(
      `SELECT id, amount_paise FROM cash_entries WHERE shop_id=$1 AND rider_id=$2
       AND id=ANY($3::uuid[]) AND settlement_id IS NULL ORDER BY id FOR UPDATE`,
      [user.shop_id, rider.id, entryIds]);
    if (entries.rowCount !== entryIds.length) throw new HttpError(409, 'Cash entries changed. Refresh the settlement and try again.');
    const expected = entries.rows.reduce((sum, row) => sum + row.amount_paise, 0);
    if (expected > 2147483647) throw new HttpError(400, 'Select a smaller group of cash entries.');
    if (expected !== input.received_paise && !input.note) throw new HttpError(400, 'Add a note explaining the difference.');
    const result = await client.query(
      `INSERT INTO settlements (shop_id,rider_id,recorded_by,submission_id,expected_paise,received_paise,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (shop_id, submission_id) DO NOTHING RETURNING *`,
      [user.shop_id, rider.id, user.id, input.submission_id, expected, input.received_paise, input.note ?? null]);
    const settlement = result.rows[0];
    if (!settlement) throw new HttpError(409, 'That settlement request ID was already used.');
    await client.query('UPDATE cash_entries SET settlement_id=$1 WHERE id=ANY($2::uuid[])', [settlement.id, entryIds]);
    return settlement;
  });
}
