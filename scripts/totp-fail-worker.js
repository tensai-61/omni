const { workerData, parentPort } = require('worker_threads');
const { recordTotpFailure } = require(workerData.ranksPath);

let database;
if (workerData.url) {
  const { openLibsqlSync } = require(workerData.adapterPath);
  database = openLibsqlSync({ url: workerData.url, authToken: workerData.authToken });
} else {
  const { DatabaseSync } = require('node:sqlite');
  database = new DatabaseSync(workerData.file);
  database.exec('PRAGMA busy_timeout = 5000');
}

let status = 0;
let message = '';
try {
  recordTotpFailure(database, 1);
} catch (error) {
  status = Number(error.status) || 500;
  message = String(error.message || '');
}
try { database.close(); } catch {}
parentPort.postMessage({ status, message });
