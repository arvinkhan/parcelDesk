import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createPool, migrate, transaction } from './db.js';
import { addShipment, applyAction, settleCash, type User } from './operations.js';
import { hashPassword } from './security.js';

export async function seed(pool: Pool) {
  const password = await hashPassword('ParcelDeskDemo!');
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(4071190)');
    const exists = await client.query("SELECT id FROM users WHERE email='dispatch@parceldesk.demo'");
    if (exists.rowCount) return;
    const { id: shop_id } = (await client.query("INSERT INTO shops (name) VALUES ('Mango Street Bakery') RETURNING id")).rows[0];
    const users: User[] = [];
    for (const [name, email, role] of [
      ['Asha Mehta', 'dispatch@parceldesk.demo', 'dispatcher'],
      ['Ravi Kumar', 'ravi@parceldesk.demo', 'rider'],
      ['Neha Rao', 'neha@parceldesk.demo', 'rider'],
    ]) {
      const result = await client.query<User>(
        'INSERT INTO users (shop_id,name,email,role,password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id,shop_id,name,role',
        [shop_id, name, email, role, password]);
      users.push(result.rows[0]);
    }
    const [owner, ravi, neha] = users;
    const data = [
      ['PD-1041', 'Kabir Verma', '12 Lake View Road, Indiranagar', 'Sourdough box', 55000],
      ['PD-1042', 'Isha Nair', '18 Cambridge Layout, Ulsoor', 'Brownie assortment', 45000],
      ['PD-1043', 'Meera Shah', '21 5th Main, Indiranagar', 'Chocolate celebration cake', 75000],
      ['PD-1044', 'Arjun Bose', '4 Church Street, Bengaluru', 'Croissant box', 0],
      ['PD-1045', 'Priya Sen', '8 Jeevan Bhima Nagar Main Road', 'Birthday cupcake set', 85000],
      ['PD-1046', 'Nikhil Das', '16 Double Road, Indiranagar', 'Lemon loaf and cookies', 65000],
      ['PD-1047', 'Devika Iyer', '33 12th Main, Indiranagar', 'Weekend pastry box', 0],
    ] as const;
    const ids: string[] = [];
    for (const [reference, customer, address, description, cod] of data) {
      const shipment = await addShipment(client, owner, {
        reference, customer, address, description, payment: cod ? 'cod' : 'prepaid', cod_paise: cod,
      });
      ids.push(shipment.id);
    }
    for (const [index, rider] of [[0, ravi], [1, ravi], [2, ravi], [3, neha], [4, neha]] as const) {
      const id = ids[index];
      const { assignment_id } = await applyAction(client, owner, id, { kind: 'assign', rider_id: rider.id });
      if (!assignment_id) throw new Error('Demo assignment was not created');
      if (index !== 4) await applyAction(client, rider, id, { kind: 'pickup', assignment_id });
      if (index < 2) await applyAction(client, rider, id, { kind: 'attempt', assignment_id, outcome: 'delivered', submission_id: randomUUID() });
      if (index === 2) await applyAction(client, rider, id, { kind: 'attempt', assignment_id, outcome: 'failed', reason: 'Customer unavailable', submission_id: randomUUID() });
    }
    const { rows } = await client.query('SELECT id FROM cash_entries WHERE shipment_id=$1', [ids[0]]);
    await settleCash(client, owner, { rider_id: ravi.id, submission_id: randomUUID(), entry_ids: [rows[0].id], received_paise: 55000 });
  });
}

export async function provisionShop(pool: Pool, env: NodeJS.ProcessEnv) {
  const input = z.object({
    SHOP_NAME: z.string().trim().min(1).max(100),
    DISPATCHER_NAME: z.string().trim().min(1).max(100),
    DISPATCHER_EMAIL: z.email().max(254),
    DISPATCHER_PASSWORD: z.string().min(12).max(128),
  }).safeParse(env);
  if (!input.success) {
    throw new Error('Set SHOP_NAME, DISPATCHER_NAME, DISPATCHER_EMAIL, and DISPATCHER_PASSWORD (at least 12 characters).');
  }
  const { SHOP_NAME, DISPATCHER_NAME, DISPATCHER_EMAIL, DISPATCHER_PASSWORD } = input.data;
  const password = await hashPassword(DISPATCHER_PASSWORD);
  await transaction(pool, async client => {
    const { id } = (await client.query('INSERT INTO shops (name) VALUES ($1) RETURNING id', [SHOP_NAME])).rows[0];
    const result = await client.query(
      `INSERT INTO users (shop_id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,'dispatcher')
       ON CONFLICT (email) DO NOTHING RETURNING id`, [id, DISPATCHER_NAME, DISPATCHER_EMAIL.toLowerCase(), password]);
    if (!result.rowCount) throw new Error('An account already uses this email.');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  try {
    await migrate(pool);
    const action = process.argv[2];
    if (action === 'seed') await seed(pool);
    if (action === 'provision') await provisionShop(pool, process.env);
    console.log(action === 'seed' ? 'Database seeded' : action === 'provision' ? 'Shop and dispatcher created' : 'Database migrated');
  } finally {
    await pool.end();
  }
}
