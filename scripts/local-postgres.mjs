import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';

const isTest = process.argv[2] === 'test';
const base = resolve('.local-db');
await mkdir(base, { recursive: true });
const databaseDir = resolve(base, isTest ? 'test-' + randomUUID() : 'demo');
const port = await new Promise((resolve, reject) => {
  const socket = createServer().listen(0, '127.0.0.1');
  socket.once('error', reject);
  socket.once('listening', () => {
    const port = socket.address().port;
    socket.close(error => error ? reject(error) : resolve(port));
  });
});
const pg = new EmbeddedPostgres({
  databaseDir, port, user: 'parcel', password: 'parcel_local_only', persistent: !isTest,
  initdbFlags: ['--locale=C', '--encoding=UTF8'], postgresFlags: ['-h', '127.0.0.1'],
  onLog: () => {}, onError: error => console.error(error),
});
let initialized = true;
try { await access(resolve(databaseDir, 'PG_VERSION')); } catch { initialized = false; }
if (!initialized) await pg.initialise();
await pg.start();
const env = {
  ...process.env,
  DATABASE_URL: 'postgres://parcel:parcel_local_only@127.0.0.1:' + port + '/postgres',
  TEST_DATABASE_URL: 'postgres://parcel:parcel_local_only@127.0.0.1:' + port + '/postgres',
  SESSION_SECRET: randomBytes(32).toString('hex'),
  DEMO_MODE: 'true', HOST: '127.0.0.1', PORT: process.env.PORT || '3000',
};

let child;
let stopping = false;
function stopChild() {
  if (stopping) return;
  stopping = true;
  child?.kill();
}
function node(args) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 || stopping) resolve();
      else reject(new Error('Node process exited with ' + (code ?? signal)));
    });
  });
}
process.on('SIGINT', stopChild);
process.on('SIGTERM', stopChild);
try {
  if (isTest) {
    await node(['--import', 'tsx', '--test', 'test/operations.test.ts']);
  } else {
    await node(['--import', 'tsx', 'src/setup.ts', 'seed']);
    if (!stopping) await node(['--import', 'tsx', 'src/server.ts']);
  }
} finally {
  await pg.stop();
}
