const { workerData, parentPort } = require('worker_threads');
const { createClient } = require('@libsql/client');
const { redact } = require('./redact');

const ready = new Int32Array(workerData.readySab);
const port = workerData.port;
let client;
try {
  client = createClient({
    url: workerData.url,
    authToken: workerData.authToken,
    intMode: 'number'
  });
} catch (error) {
  port.postMessage({ id: 0, ok: false, message: redact(String(error && error.message || 'libSQL istemcisi açılmadı')), code: 'LIBSQL_CONFIG' });
  Atomics.store(ready, 0, 2);
  Atomics.notify(ready, 0);
}
let tx = null;
let chain = Promise.resolve();

function safeMessage(error) {
  const raw = `${error?.code ? `${error.code}: ` : ''}${error?.message || error || ''}`;
  let text = redact(raw);
  for (const secret of [workerData.url, workerData.authToken]) {
    const value = String(secret || '');
    if (value.length >= 6) text = text.split(value).join('[redacted]');
  }
  return text;
}

function normalizeValue(value) {
  if (typeof value !== 'bigint') return value;
  const asNumber = Number(value);
  if (Number.isSafeInteger(asNumber) && BigInt(asNumber) === value) return asNumber;
  return value.toString();
}

function plainRow(result, row) {
  const plain = {};
  for (const column of result.columns) {
    if (!Object.hasOwn(plain, column)) plain[column] = normalizeValue(row[column]);
  }
  return plain;
}

function resultOf(result, method) {
  if (method === 'run') {
    return {
      changes: Number(result.rowsAffected || 0),
      lastInsertRowid: normalizeValue(result.lastInsertRowid ?? 0)
    };
  }
  const rows = result.rows.map(row => plainRow(result, row));
  if (method === 'get') return rows[0];
  return rows;
}

function errorPayload(error) {
  const message = safeMessage(error);
  const payload = { message, code: error?.code || '', name: error?.name || 'Error' };
  if (error?.rawCode) payload.errcode = Number(error.rawCode);
  else if (/UNIQUE constraint/i.test(message)) payload.errcode = 2067;
  return payload;
}

function txControl(sql) {
  const text = String(sql || '').trim().replace(/;+\s*$/g, '');
  if (/^begin(\s+(immediate|deferred|exclusive|transaction))?$/i.test(text)) return 'begin';
  if (/^commit$/i.test(text)) return 'commit';
  if (/^rollback$/i.test(text)) return 'rollback';
  return '';
}

async function discardTx() {
  const current = tx;
  tx = null;
  if (!current) return;
  try {
    await current.rollback();
  } catch {
    try { current.close(); } catch {}
  }
}

async function begin() {
  if (tx) throw Object.assign(new Error('İşlem zaten açık'), { code: 'TRANSACTION_OPEN' });
  const started = await client.transaction('write');
  tx = started;
  try {
    await started.execute('SELECT 1');
  } catch (error) {
    await discardTx();
    throw error;
  }
}

async function commit() {
  const current = tx;
  tx = null;
  if (!current) throw Object.assign(new Error('Açık işlem yok'), { code: 'NO_TRANSACTION' });
  await current.commit();
}

async function query(sql, args, method) {
  const target = tx || client;
  const result = await target.execute({ sql, args: args.map(value => value === undefined ? null : value) });
  return resultOf(result, method);
}

async function exec(sql) {
  const control = txControl(sql);
  if (control === 'begin') return begin();
  if (control === 'commit') return commit();
  if (control === 'rollback') return discardTx();
  if (!String(sql || '').trim()) return;
  if (tx) await tx.executeMultiple(sql);
  else await client.executeMultiple(sql);
}

async function handle(message) {
  if (message.op.type === 'close') {
    await discardTx();
    client.close();
    return null;
  }
  if (message.op.type === 'exec') {
    await exec(message.op.sql);
    return null;
  }
  return query(message.op.sql, message.op.args || [], message.op.method);
}

function reply(message, body) {
  port.postMessage({ id: message.id, ...body });
  Atomics.store(message.signal, 0, 1);
  Atomics.notify(message.signal, 0);
}

if (client) parentPort.on('message', message => {
  chain = chain.then(async () => {
    try {
      const result = await handle(message);
      reply(message, { ok: true, result });
    } catch (error) {
      reply(message, { ok: false, ...errorPayload(error) });
    }
  });
});

if (client) client.execute('SELECT 1').then(() => {
  port.postMessage({ id: 0, ok: true });
  Atomics.store(ready, 0, 1);
  Atomics.notify(ready, 0);
}).catch(error => {
  port.postMessage({ id: 0, ok: false, ...errorPayload(error) });
  Atomics.store(ready, 0, 2);
  Atomics.notify(ready, 0);
});
