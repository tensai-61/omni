const HOSTED_REQUIRED = [
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'SESSION_SECRET',
  'TOTP_ENC_KEY',
  'ADMIN_EMAIL'
];

const SMTP_REQUIRED = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'EMAIL_FROM'
];

function trimmed(env, name) {
  return String(env[name] || '').trim();
}

function isLoopbackHost(value) {
  const name = String(value || '').trim().toLowerCase();
  return name === '' || name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function isHosted(env = process.env) {
  if (trimmed(env, 'OMNI_HOSTED') === '1') return true;
  return trimmed(env, 'NODE_ENV') === 'production' && !isLoopbackHost(env.HOST || '127.0.0.1');
}

function driverSelection(env = process.env) {
  const url = trimmed(env, 'TURSO_DATABASE_URL');
  const token = trimmed(env, 'TURSO_AUTH_TOKEN');
  if (url && token) return { driver: 'libsql' };
  if (url || token) {
    throw new Error('TURSO_DATABASE_URL ve TURSO_AUTH_TOKEN birlikte tanımlanmalı. Biri boş bırakılamaz.');
  }
  return { driver: 'sqlite' };
}

function missingMailSettings(env) {
  if (trimmed(env, 'BREVO_API_KEY')) {
    return trimmed(env, 'MAIL_FROM_EMAIL') ? [] : ['MAIL_FROM_EMAIL'];
  }
  return SMTP_REQUIRED.filter(name => !trimmed(env, name));
}

function assertRuntimeConfig(env = process.env) {
  const selection = driverSelection(env);
  if (!isHosted(env)) return { hosted: false, driver: selection.driver };
  const missing = [
    ...HOSTED_REQUIRED.filter(name => !trimmed(env, name)),
    ...missingMailSettings(env)
  ];
  if (trimmed(env, 'TRUST_PROXY') !== '1') missing.push('TRUST_PROXY');
  if (missing.length) {
    throw new Error(`Üretim ayarı eksik: ${missing.join(', ')}. Değerler yazılmadı.`);
  }
  if (trimmed(env, 'ONLINE_LOCK_TRIGGER') === '1') {
    throw new Error('Üretimde ONLINE_LOCK_TRIGGER kapalı olmalı (boş veya 0).');
  }
  if (trimmed(env, 'SESSION_SECRET').length < 32) {
    throw new Error('SESSION_SECRET en az 32 karakter olmalı. Değer yazılmadı.');
  }
  if (trimmed(env, 'TOTP_ENC_KEY').length < 32) {
    throw new Error('TOTP_ENC_KEY en az 32 karakter olmalı. Değer yazılmadı.');
  }
  if (!trimmed(env, 'BREVO_API_KEY')) {
    const smtpPort = Number(trimmed(env, 'SMTP_PORT'));
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
      throw new Error('SMTP_PORT geçerli bir kapı numarası olmalı.');
    }
  }
  return { hosted: true, driver: 'libsql' };
}

module.exports = {
  HOSTED_REQUIRED,
  isHosted,
  isLoopbackHost,
  driverSelection,
  assertRuntimeConfig
};
