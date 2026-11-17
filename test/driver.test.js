const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { driverSelection, assertRuntimeConfig } = require('../lib/config');
const { openDatabase } = require('../lib/db');
const { redact } = require('../lib/redact');

const hostedBase = {
  NODE_ENV: 'production',
  OMNI_HOSTED: '1',
  HOST: '0.0.0.0',
  TRUST_PROXY: '1',
  ONLINE_LOCK_TRIGGER: '0',
  TURSO_DATABASE_URL: 'libsql://omni-example.turso.io',
  TURSO_AUTH_TOKEN: 'database-scoped-token-value',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  TOTP_ENC_KEY: 'fedcba9876543210fedcba9876543210',
  ADMIN_EMAIL: 'admin@example.com',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'mailer',
  SMTP_PASS: 'fresh-smtp-password',
  EMAIL_FROM: 'omni@example.com'
};

test('driver selection uses libSQL only when both Turso variables are set', () => {
  assert.equal(driverSelection({}).driver, 'sqlite');
  assert.equal(driverSelection({ TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '' }).driver, 'sqlite');
  assert.equal(driverSelection({
    TURSO_DATABASE_URL: 'libsql://omni-example.turso.io',
    TURSO_AUTH_TOKEN: 'database-scoped-token-value'
  }).driver, 'libsql');
  assert.throws(() => driverSelection({ TURSO_DATABASE_URL: 'libsql://omni-example.turso.io' }), /birlikte/);
  assert.throws(() => driverSelection({ TURSO_AUTH_TOKEN: 'database-scoped-token-value' }), /birlikte/);
});

test('hosted production names the missing settings and does not echo secrets', () => {
  const secret = 'fresh-smtp-password';
  const token = 'database-scoped-token-value';
  assert.throws(() => assertRuntimeConfig({
    ...hostedBase,
    TURSO_DATABASE_URL: '',
    TURSO_AUTH_TOKEN: '',
    SESSION_SECRET: 'too-short'
  }), error => {
    assert.match(error.message, /TURSO_DATABASE_URL/);
    assert.match(error.message, /TURSO_AUTH_TOKEN/);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes('too-short'), false);
    return true;
  });
  assert.throws(() => assertRuntimeConfig({ ...hostedBase, TOTP_ENC_KEY: '' }), /TOTP_ENC_KEY/);
  assert.throws(() => assertRuntimeConfig({ ...hostedBase, TOTP_ENC_KEY: 'kisa-anahtar' }), error => {
    assert.match(error.message, /TOTP_ENC_KEY/);
    assert.equal(error.message.includes('kisa-anahtar'), false);
    return true;
  });
  assert.throws(() => assertRuntimeConfig({ ...hostedBase, TRUST_PROXY: '' }), /TRUST_PROXY/);
  assert.throws(() => assertRuntimeConfig({ ...hostedBase, ONLINE_LOCK_TRIGGER: '1' }), error => {
    assert.match(error.message, /ONLINE_LOCK_TRIGGER/);
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes('libsql://'), false);
    return true;
  });
  assert.equal(assertRuntimeConfig({ ...hostedBase }).driver, 'libsql');
  assert.equal(assertRuntimeConfig({ NODE_ENV: 'production', HOST: '127.0.0.1' }).hosted, false);
  const brevoHosted = { ...hostedBase, BREVO_API_KEY: 'brevo-test-key', MAIL_FROM_EMAIL: 'noreply@example.com' };
  delete brevoHosted.SMTP_HOST;
  delete brevoHosted.SMTP_PORT;
  delete brevoHosted.SMTP_USER;
  delete brevoHosted.SMTP_PASS;
  delete brevoHosted.EMAIL_FROM;
  assert.equal(assertRuntimeConfig(brevoHosted).hosted, true);
  assert.throws(() => assertRuntimeConfig({ ...brevoHosted, MAIL_FROM_EMAIL: '' }), error => {
    assert.match(error.message, /MAIL_FROM_EMAIL/);
    assert.equal(error.message.includes('brevo-test-key'), false);
    return true;
  });
});

test('local sqlite sets a busy timeout so a second process can wait', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-busy-'));
  const database = openDatabase({ DATABASE_FILE: path.join(dir, 'app.db') });
  try {
    const row = database.prepare('PRAGMA busy_timeout').get();
    assert.equal(Number(row.timeout), 5000);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('redact removes database URL, token, SMTP password, Brevo key, and session secret', () => {
  const env = {
    TURSO_DATABASE_URL: 'libsql://omni-secret-db.turso.io',
    TURSO_AUTH_TOKEN: 'scoped-token-do-not-print',
    SMTP_PASS: 'smtp-pass-do-not-print',
    BREVO_API_KEY: 'brevo-api-key-do-not-print',
    SESSION_SECRET: 'session-secret-do-not-print-0123456789',
    TOTP_ENC_KEY: 'totp-enc-key-do-not-print-0123456789'
  };
  const text = redact(
    `connect ${env.TURSO_DATABASE_URL} auth ${env.TURSO_AUTH_TOKEN} pass ${env.SMTP_PASS} brevo ${env.BREVO_API_KEY} session ${env.SESSION_SECRET} totp ${env.TOTP_ENC_KEY} Bearer ${env.TURSO_AUTH_TOKEN}`,
    env
  );
  assert.equal(text.includes('omni-secret-db'), false);
  assert.equal(text.includes('scoped-token'), false);
  assert.equal(text.includes('smtp-pass'), false);
  assert.equal(text.includes('brevo-api-key'), false);
  assert.equal(text.includes('session-secret'), false);
  assert.equal(text.includes('totp-enc-key'), false);
  assert.match(text, /\[redacted/);
});
