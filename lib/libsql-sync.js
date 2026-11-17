const path = require('path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const { redact } = require('./redact');

const CALL_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 30_000;

function fail(message) {
  const error = new Error(redact(message));
  error.code = 'LIBSQL_SYNC';
  return error;
}

function openLibsqlSync({ url, authToken }) {
  if (!url || !authToken) throw fail('libSQL adresi ve jetonu birlikte gerekli.');
  const readySab = new SharedArrayBuffer(4);
  const ready = new Int32Array(readySab);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(path.join(__dirname, 'libsql-worker.js'), {
    workerData: { url, authToken, readySab, port: port2 },
    transferList: [port2]
  });
  worker.stdout?.resume();
  worker.stderr?.on('data', chunk => {
    const text = redact(chunk.toString('utf8')).trim();
    if (text) console.error(text);
  });
  const readyWait = Atomics.wait(ready, 0, 0, READY_TIMEOUT_MS);
  worker.unref();
  const readyDeadline = Date.now() + 2000;
  let readyMessage = receiveMessageOnPort(port1);
  while (!readyMessage && Date.now() < readyDeadline && Atomics.load(ready, 0) !== 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    readyMessage = receiveMessageOnPort(port1);
  }
  if (Atomics.load(ready, 0) !== 1) {
    const detail = readyMessage?.message?.message || '';
    worker.terminate();
    throw fail(detail || (readyWait === 'timed-out' ? 'libSQL bağlantısı zaman aşımına uğradı.' : 'libSQL bağlantısı kurulamadı.'));
  }
  let nextId = 0;
  let closed = false;

  function call(op) {
    if (closed) throw fail('Veritabanı bağlantısı kapalı.');
    const id = ++nextId;
    const signal = new Int32Array(new SharedArrayBuffer(4));
    worker.postMessage({ id, signal, op });
    const deadline = Date.now() + CALL_TIMEOUT_MS;
    let received = null;
    while (!received && Date.now() < deadline) {
      const state = Atomics.load(signal, 0);
      if (state !== 1) Atomics.wait(signal, 0, state, Math.min(1000, Math.max(1, deadline - Date.now())));
      const next = receiveMessageOnPort(port1);
      if (next && next.message?.id === id) received = next;
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    if (!received) throw fail('Veritabanı yanıtı gelmedi.');
    const message = received.message;
    if (message.ok) return message.result;
    const error = new Error(redact(message.message || 'Veritabanı hatası'));
    if (message.code) error.code = message.code;
    if (message.errcode) error.errcode = message.errcode;
    throw error;
  }

  return {
    driver: 'libsql',
    exec(sql) {
      call({ type: 'exec', sql: String(sql) });
    },
    prepare(sql) {
      const text = String(sql);
      return {
        get(...args) {
          return call({ type: 'query', method: 'get', sql: text, args });
        },
        all(...args) {
          return call({ type: 'query', method: 'all', sql: text, args });
        },
        run(...args) {
          return call({ type: 'query', method: 'run', sql: text, args });
        }
      };
    },
    close() {
      if (closed) return;
      try { call({ type: 'close' }); } catch {}
      closed = true;
      worker.terminate();
    }
  };
}

module.exports = { openLibsqlSync };
