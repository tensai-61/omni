const http = require('http');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { canonicalEmail } = require('./lib/account');
const { mailConfigured, sendMail } = require('./lib/mail');
const {
  installRanks,
  ensureRank,
  rankOf,
  writeAudit,
  recordViewPii,
  assertOutranks,
  actingAdminEmail,
  PENDING_2FA_MS,
  verifyFactor
} = require('./lib/ranks');
const { assertRuntimeConfig, isHosted } = require('./lib/config');
const { openDatabase } = require('./lib/db');
const { redact } = require('./lib/redact');
const { legalPages } = require('./lib/legal');
const {
  installOnlineSchema,
  seedFreeTeams,
  createOnlineApi,
  scheduleOnlineLock,
  catchUpDailySim,
  ensureStartingOmni
} = require('./lib/online-league');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
try {
  assertRuntimeConfig();
} catch (error) {
  console.error(redact(error.message));
  process.exit(1);
}
const root = __dirname;
const dataFile = process.env.DATA_FILE || path.join(root, 'tournament-data.json');
const defaultBodyLimit = 1 * 1024 * 1024;
const accountDataBodyLimit = 20 * 1024 * 1024;
const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
const verificationLifetime = 10 * 60 * 1000;
const passwordResetLifetime = 30 * 60 * 1000;
const maxPasswordResetEmailsPerHour = 3;
const verificationResendDelay = 60 * 1000;
const maxVerificationEmailsPerHour = 5;
const maxVerificationAttempts = 5;
const maxAvatarBytes = 512 * 1024;
const unverifiedAccountLifetime = 24 * 60 * 60 * 1000;
const authRateLimits = new Map();
const defaultData = { tournaments: [], savedTeams: [], sharedTournamentOverrides: [] };
const scrypt = promisify(crypto.scrypt);
const anonymousVerifyWindowMs = 15 * 60 * 1000;
const maxTrackedFailureKeys = 4096;
const anonymousVerifyFailures = new Map();
const dummyVerifySalt = Buffer.alloc(16, 0x5a);
const scryptParallel = Math.max(2, Math.min(4, os.cpus().length || 2));
const scryptPerIpWindowMs = 10 * 1000;
const scryptPerIpLimit = 30;
const scryptPerIpInFlight = 2;
const scryptQueueMax = scryptParallel * 4;
let scryptActive = 0;
const scryptQueue = [];
const scryptInFlightByIp = new Map();
const scryptIpHits = new Map();

function trustProxyEnabled() {
  return String(process.env.TRUST_PROXY || '').trim() === '1';
}

const adminEmail = canonicalEmail(process.env.ADMIN_EMAIL || '');
if (!adminEmail) {
  console.warn('Uyarı: ADMIN_EMAIL tanımlı değil. İlk yönetici otomatik atanmayacak.');
}

const database = openDatabase();
database.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS app_data (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_secrets (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    secret TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    username TEXT NOT NULL DEFAULT '',
    avatar_data TEXT,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    banned INTEGER NOT NULL DEFAULT 0,
    isBanned INTEGER NOT NULL DEFAULT 0,
    banReason TEXT,
    banNote TEXT,
    banType TEXT NOT NULL DEFAULT 'PERMANENT' CHECK (banType IN ('PERMANENT', 'TEMPORARY')),
    bannedAt TEXT,
    bannedUntil TEXT,
    deviceId TEXT,
    isDeviceBanned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS verification_codes (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_sent_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_registrations (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    username TEXT NOT NULL,
    avatar_data TEXT,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    device_id TEXT,
    registration_key TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_sent_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pending_registrations_email ON pending_registrations(email);
  CREATE TABLE IF NOT EXISTS verification_sends (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    sent_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS verification_sends_email_sent ON verification_sends(email, sent_at);
  CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_data (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS packages (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price REAL NOT NULL CHECK (price >= 0),
    currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR')),
    stock INTEGER NOT NULL CHECK (stock >= 0),
    config TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shop_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    account_name TEXT NOT NULL DEFAULT '',
    iban TEXT NOT NULL DEFAULT '',
    bank_name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    package_id TEXT,
    package_title TEXT NOT NULL,
    price REAL NOT NULL,
    currency TEXT NOT NULL,
    reference_code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
    created_at TEXT NOT NULL,
    reviewed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS admin_pack_password_attempts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0 AND failures <= 5),
    locked_until INTEGER
  );
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS password_reset_tokens_user ON password_reset_tokens(user_id);
  CREATE TABLE IF NOT EXISTS password_reset_sends (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    sent_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS password_reset_sends_email_sent ON password_reset_sends(email, sent_at);
`);

const userColumns = new Set(database.prepare('PRAGMA table_info(users)').all().map(column => column.name));
if (!userColumns.has('password_salt')) {
  database.exec('ALTER TABLE users ADD COLUMN password_salt TEXT');
}
if (!userColumns.has('verified')) {
  database.exec('ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0');
  if (userColumns.has('email_verified')) {
    database.exec('UPDATE users SET verified = email_verified');
  }
}
if (!userColumns.has('username')) {
  database.exec("ALTER TABLE users ADD COLUMN username TEXT NOT NULL DEFAULT ''");
  database.exec("UPDATE users SET username = substr(email, 1, instr(email, '@') - 1) WHERE username = ''");
}
if (!userColumns.has('avatar_data')) {
  database.exec('ALTER TABLE users ADD COLUMN avatar_data TEXT');
}
if (!userColumns.has('banned')) {
  database.exec('ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0');
}
if (!userColumns.has('isBanned')) {
  database.exec('ALTER TABLE users ADD COLUMN isBanned INTEGER NOT NULL DEFAULT 0');
  if (userColumns.has('banned')) {
    database.exec('UPDATE users SET isBanned = banned');
  }
}
if (!userColumns.has('banReason')) {
  database.exec('ALTER TABLE users ADD COLUMN banReason TEXT');
}
if (!userColumns.has('banNote')) {
  database.exec('ALTER TABLE users ADD COLUMN banNote TEXT');
}
if (!userColumns.has('banType')) {
  database.exec("ALTER TABLE users ADD COLUMN banType TEXT NOT NULL DEFAULT 'PERMANENT' CHECK (banType IN ('PERMANENT', 'TEMPORARY'))");
}
if (!userColumns.has('bannedAt')) {
  database.exec('ALTER TABLE users ADD COLUMN bannedAt TEXT');
}
if (!userColumns.has('bannedUntil')) {
  database.exec('ALTER TABLE users ADD COLUMN bannedUntil TEXT');
}
if (!userColumns.has('deviceId')) {
  database.exec('ALTER TABLE users ADD COLUMN deviceId TEXT');
}
if (!userColumns.has('isDeviceBanned')) {
  database.exec('ALTER TABLE users ADD COLUMN isDeviceBanned INTEGER NOT NULL DEFAULT 0');
}
if (!userColumns.has('role')) {
  database.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}
installRanks(database, adminEmail);

const packageColumns = new Set(database.prepare('PRAGMA table_info(packages)').all().map(column => column.name));
if (!packageColumns.has('approval_status')) {
  database.exec("ALTER TABLE packages ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'");
}
if (!packageColumns.has('submitted_by')) {
  database.exec('ALTER TABLE packages ADD COLUMN submitted_by INTEGER');
}
if (!packageColumns.has('reviewed_at')) {
  database.exec('ALTER TABLE packages ADD COLUMN reviewed_at TEXT');
}
if (!packageColumns.has('roster')) {
  database.exec('ALTER TABLE packages ADD COLUMN roster TEXT');
}

installOnlineSchema(database);
seedFreeTeams(database);

function resolveAppSecret() {
  const fromEnv = String(process.env.SESSION_SECRET || '').trim();
  if (fromEnv) return fromEnv;
  const row = database.prepare('SELECT secret FROM app_secrets WHERE id = 1').get();
  const generated = row?.secret || crypto.randomBytes(32).toString('hex');
  if (!row) database.prepare('INSERT INTO app_secrets (id, secret) VALUES (1, ?)').run(generated);
  return generated;
}
const appSecret = resolveAppSecret();

function resolveTotpKey() {
  const fromEnv = String(process.env.TOTP_ENC_KEY || '').trim();
  if (fromEnv) return fromEnv;
  if (isHosted()) {
    throw new Error('TOTP_ENC_KEY en az 32 karakter olmalı. Değer yazılmadı.');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS totp_key (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      secret TEXT NOT NULL
    );
  `);
  const row = database.prepare('SELECT secret FROM totp_key WHERE id = 1').get();
  const generated = row?.secret || crypto.randomBytes(32).toString('hex');
  if (!row) database.prepare('INSERT INTO totp_key (id, secret) VALUES (1, ?)').run(generated);
  return generated;
}
const totpKey = resolveTotpKey();

const readDatabase = database.prepare('SELECT payload FROM app_data WHERE id = 1');
const readUser = database.prepare('SELECT id, email, username, avatar_data, verified FROM users WHERE email = ? COLLATE NOCASE');
const insertUnverifiedUser = database.prepare("INSERT INTO users (email, username, avatar_data, password_hash, password_salt, verified, role, deviceId, created_at) VALUES (?, ?, ?, ?, ?, 0, 'user', ?, ?)");
const insertVerifiedUser = database.prepare("INSERT INTO users (email, username, avatar_data, password_hash, password_salt, verified, role, deviceId, created_at) VALUES (?, ?, ?, ?, ?, 1, 'user', ?, ?)");
const applyPendingRegistration = database.prepare(`
  UPDATE users
  SET username = ?, avatar_data = ?, password_hash = ?, password_salt = ?, deviceId = ?, verified = 1
  WHERE id = ? AND verified = 0
`);
const deleteUnverifiedUser = database.prepare('DELETE FROM users WHERE id = ? AND verified = 0');
const deleteVerificationCodes = database.prepare('DELETE FROM verification_codes WHERE user_id = ?');
const deleteUserSessions = database.prepare('DELETE FROM user_sessions WHERE user_id = ?');
const purgeExpiredUnverifiedUsers = database.prepare('DELETE FROM users WHERE verified = 0 AND created_at < ?');
const insertPendingRegistration = database.prepare(`
  INSERT INTO pending_registrations (
    email, username, avatar_data, password_hash, password_salt, device_id,
    registration_key, code_hash, expires_at, attempts, last_sent_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
`);
const readPendingByEmail = database.prepare(`
  SELECT id, email, username, avatar_data, password_hash, password_salt, device_id,
    registration_key, code_hash, expires_at, attempts, last_sent_at, created_at
  FROM pending_registrations WHERE email = ? COLLATE NOCASE ORDER BY id ASC
`);
const incrementPendingAttempts = database.prepare('UPDATE pending_registrations SET attempts = attempts + 1 WHERE id = ? AND attempts < ?');
const updatePendingCode = database.prepare(`
  UPDATE pending_registrations
  SET registration_key = ?, code_hash = ?, expires_at = ?, attempts = 0, last_sent_at = ?
  WHERE id = ?
`);
const deletePendingById = database.prepare('DELETE FROM pending_registrations WHERE id = ?');
const deletePendingByEmail = database.prepare('DELETE FROM pending_registrations WHERE email = ? COLLATE NOCASE');
const purgeExpiredPendingRegistrations = database.prepare('DELETE FROM pending_registrations WHERE created_at < ?');
const verificationSendCounts = database.prepare(`
  SELECT
    SUM(CASE WHEN sent_at > ? THEN 1 ELSE 0 END) AS recent,
    SUM(CASE WHEN sent_at > ? THEN 1 ELSE 0 END) AS hourly
  FROM verification_sends WHERE email = ? COLLATE NOCASE
`);
const insertVerificationSend = database.prepare('INSERT INTO verification_sends (email, sent_at) VALUES (?, ?)');
const deleteVerificationSend = database.prepare('DELETE FROM verification_sends WHERE id = ?');
const purgeOldVerificationSends = database.prepare('DELETE FROM verification_sends WHERE sent_at < ?');
const sessionColumns = new Set(database.prepare('PRAGMA table_info(user_sessions)').all().map(column => column.name));
if (!sessionColumns.has('pending_2fa')) {
  database.exec('ALTER TABLE user_sessions ADD COLUMN pending_2fa INTEGER NOT NULL DEFAULT 0');
}
const sessionForToken = database.prepare(`
  SELECT users.id, users.email, users.username, users.avatar_data, users.verified, users.role,
    users.banned, users.isBanned, users.banReason, users.banNote, users.banType,
    users.bannedUntil, users.deviceId, users.isDeviceBanned, user_sessions.expires_at,
    user_sessions.pending_2fa,
    user_roles.role AS rank, COALESCE(user_security.totp_enabled, 0) AS totp_enabled
  FROM user_sessions JOIN users ON users.id = user_sessions.user_id
  LEFT JOIN user_roles ON user_roles.user_id = users.id
  LEFT JOIN user_security ON user_security.user_id = users.id
  WHERE user_sessions.token_hash = ?
`);
const clearUserBan = database.prepare(`
  UPDATE users SET banned = 0, isBanned = 0, banReason = NULL, banNote = NULL,
    banType = 'PERMANENT', bannedAt = NULL, bannedUntil = NULL, isDeviceBanned = 0
  WHERE id = ?
`);
const saveUserDeviceId = database.prepare('UPDATE users SET deviceId = ? WHERE id = ?');
const usersByDeviceId = database.prepare(`
  SELECT id, banned, isBanned, banReason, banNote, banType, bannedUntil, deviceId, isDeviceBanned
  FROM users WHERE deviceId = ? AND isDeviceBanned = 1
`);
const BAN_DURATIONS = {
  PERMANENT: null,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
};
const insertSession = database.prepare('INSERT INTO user_sessions (token_hash, user_id, expires_at, pending_2fa) VALUES (?, ?, ?, ?)');
const promotePendingSession = database.prepare('UPDATE user_sessions SET pending_2fa = 0, expires_at = ? WHERE token_hash = ? AND pending_2fa = 1');
const readUserData = database.prepare('SELECT payload FROM user_data WHERE user_id = ?');
const writeUserData = database.prepare(`
  INSERT INTO user_data (user_id, payload, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
`);
const deleteSession = database.prepare('DELETE FROM user_sessions WHERE token_hash = ?');
const insertPasswordResetToken = database.prepare('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
const readPasswordResetToken = database.prepare('SELECT token_hash, user_id, expires_at FROM password_reset_tokens WHERE token_hash = ?');
const deletePasswordResetToken = database.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?');
const deletePasswordResetTokensForUser = database.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?');
const purgeExpiredPasswordResetTokens = database.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ?');
const updateUserPassword = database.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?');
const passwordResetSendCounts = database.prepare('SELECT COUNT(*) AS hourly FROM password_reset_sends WHERE sent_at > ? AND email = ? COLLATE NOCASE');
const insertPasswordResetSend = database.prepare('INSERT INTO password_reset_sends (email, sent_at) VALUES (?, ?)');
const purgeOldPasswordResetSends = database.prepare('DELETE FROM password_reset_sends WHERE sent_at < ?');

function readLegacyData() {
  const row = readDatabase.get();
  if (row?.payload) return normalizeData(JSON.parse(row.payload));
  if (!fs.existsSync(dataFile)) return defaultData;
  return normalizeData(JSON.parse(fs.readFileSync(dataFile, 'utf8')));
}

function normalizeData(data) {
  return sanitizeStored({
    tournaments: Array.isArray(data?.tournaments) ? data.tournaments : [],
    savedTeams: Array.isArray(data?.savedTeams) ? data.savedTeams : [],
    sharedTournamentOverrides: Array.isArray(data?.sharedTournamentOverrides) ? data.sharedTournamentOverrides : []
  });
}

const legacyData = readLegacyData();

function readRequestBody(request, maxBytes) {
  const limit = Number.isFinite(maxBytes) ? maxBytes : defaultBodyLimit;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const tooLarge = () => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      request.resume();
      reject(Object.assign(new Error('Veri boyutu çok büyük'), { status: 413 }));
    };
    if (Number(request.headers['content-length']) > limit) {
      tooLarge();
      return;
    }
    request.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      // Parçaları önce Buffer olarak birleştirip tek seferde UTF-8 çözüyoruz;
      // aksi halde bölünen çok baytlı karakterler (ç, ğ, ş...) bozulur.
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store'
  };
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(data));
}

function sendNotFound(response) {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders() });
  response.end('Not found');
}

function isInsideDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

// Read before writeHead. A missing file must still be able to send 404; once
// 200 headers are flushed, the request catch block can only destroy the socket.
function sendStaticFile(response, filePath, headers, allowedDirectory) {
  const allowedLexical = path.resolve(allowedDirectory);
  const lexical = path.resolve(filePath);
  if (!isInsideDirectory(allowedLexical, lexical)) {
    sendNotFound(response);
    return;
  }
  let realAllowed;
  let realPath;
  try {
    realAllowed = fs.realpathSync(allowedLexical);
    realPath = fs.realpathSync(lexical);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      sendNotFound(response);
      return;
    }
    throw error;
  }
  // Direct child of the allowed directory only. A symlink such as
  // locale.js -> tournament.db stays inside the app root and would otherwise be served.
  if (path.dirname(realPath) !== realAllowed || path.basename(realPath) !== path.basename(lexical)) {
    sendNotFound(response);
    return;
  }
  let body;
  try {
    body = fs.readFileSync(realPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      sendNotFound(response);
      return;
    }
    throw error;
  }
  response.writeHead(200, {
    ...securityHeaders(),
    ...headers
  });
  response.end(body);
}

function getCookie(request, name) {
  const cookies = (request.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(cookie.slice(separator + 1).trim());
  }
  return '';
}

function isLoopbackName(value) {
  if (typeof value !== 'string') return false;
  let name = value.trim().toLowerCase().replace(/\.$/, '');
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1);
  if (name.startsWith('::ffff:')) name = name.slice('::ffff:'.length);
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

function requestHostname(request) {
  const raw = request.headers.host;
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    return new URL(`http://${raw.trim()}`).hostname;
  } catch {
    return '';
  }
}

// TRUST_PROXY=1 reads the leftmost X-Forwarded-Proto value, so the reverse
// proxy must overwrite that header rather than append to it.
function forwardedProto(request) {
  if (!trustProxyEnabled()) return '';
  const header = request.headers['x-forwarded-proto'];
  const value = Array.isArray(header) ? header.join(',') : header || '';
  return String(value).split(',')[0].trim().toLowerCase();
}

function isHttps(request) {
  if (request.socket?.encrypted) return true;
  return forwardedProto(request) === 'https';
}

function validPublicHost(request) {
  const hostHeader = request.headers.host;
  if (typeof hostHeader !== 'string') return '';
  const value = hostHeader.trim();
  if (/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(value)) return value;
  if (/^\[[0-9a-fA-F:]+\](?::\d{1,5})?$/.test(value)) return value;
  return '';
}

function shouldRedirectToHttps(request) {
  return process.env.NODE_ENV === 'production' && forwardedProto(request) === 'http';
}

function sendHealth(response, request) {
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders()
  };
  if (request && process.env.NODE_ENV === 'production' && isHttps(request)) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  response.writeHead(200, headers);
  response.end('ok');
}

function redirectToHttps(request, response, requestUrl) {
  const publicHost = validPublicHost(request);
  if (!publicHost) {
    sendJson(response, 400, { ok: false, error: 'Geçersiz istek' });
    return;
  }
  response.writeHead(308, {
    Location: `https://${publicHost}${requestUrl.pathname}${requestUrl.search}`,
    'Cache-Control': 'no-store',
    ...securityHeaders()
  });
  response.end();
}

function isLocalRequest(request) {
  if (trustProxyEnabled()) return false;
  const remote = request.socket?.remoteAddress;
  return isLoopbackName(requestHostname(request)) && isLoopbackName(remote);
}

function cookieSecureMode() {
  if (process.env.NODE_ENV === 'production') return 'always';
  const mode = String(process.env.COOKIE_SECURE || 'auto').trim().toLowerCase();
  if (mode === 'always' || mode === 'never' || mode === 'auto') return mode;
  return 'auto';
}

function sessionCookieIsSecure(request) {
  const mode = cookieSecureMode();
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  if (!request) return true;
  return !isLocalRequest(request) || isHttps(request);
}

function setSessionCookie(response, token, maxAge, request) {
  const secure = sessionCookieIsSecure(request) ? '; Secure' : '';
  response.setHeader('Set-Cookie', `turnuva_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(response, request) {
  setSessionCookie(response, '', 0, request);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPendingCode(registrationKey, code) {
  return crypto.createHmac('sha256', appSecret).update(`pending:${registrationKey}:${code}`).digest('hex');
}

function isUniqueConstraintError(error) {
  if (Number(error?.errcode) === 2067) return true;
  return String(error?.message || '').includes('UNIQUE constraint');
}

function verificationSendBlock(email) {
  const now = Date.now();
  const counts = verificationSendCounts.get(now - verificationResendDelay, now - 60 * 60 * 1000, email);
  if (Number(counts?.recent || 0) > 0) {
    return { status: 429, error: 'Yeni kod istemeden önce bir dakika bekleyin' };
  }
  if (Number(counts?.hourly || 0) >= maxVerificationEmailsPerHour) {
    return { status: 429, error: 'Bu e-posta için çok fazla doğrulama kodu istendi. Bir saat sonra tekrar deneyin.' };
  }
  return null;
}

function reserveVerificationSend(email) {
  const block = verificationSendBlock(email);
  if (block) return { block };
  const now = Date.now();
  const inserted = insertVerificationSend.run(email, now);
  return { id: Number(inserted.lastInsertRowid), now };
}

function issuePendingCode() {
  const registrationKey = crypto.randomBytes(16).toString('hex');
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const now = Date.now();
  return {
    registrationKey,
    code,
    codeHash: hashPendingCode(registrationKey, code),
    expiresAt: now + verificationLifetime,
    now
  };
}

function pendingCodeMatches(row, code) {
  if (!/^\d{6}$/.test(code)) return false;
  const actual = Buffer.from(hashPendingCode(row.registration_key, code), 'hex');
  const expected = Buffer.from(String(row.code_hash || ''), 'hex');
  return expected.length === actual.length && expected.length > 0 && crypto.timingSafeEqual(expected, actual);
}

async function pendingPasswordMatches(row, password, ip) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return false;
  if (!row?.password_salt || !row?.password_hash) return false;
  const candidate = await runScrypt(password, Buffer.from(row.password_salt, 'hex'), ip);
  const expected = Buffer.from(row.password_hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function legacyCollisionEmail(canonical, token) {
  const at = canonical.lastIndexOf('@');
  const local = at > 0 ? canonical.slice(0, at) : 'hesap';
  const domain = at > 0 ? canonical.slice(at + 1) : 'invalid.local';
  const suffix = `+legacy${token}`;
  const trimmedLocal = local.slice(0, Math.max(1, 64 - suffix.length));
  return `${trimmedLocal}${suffix}@${domain}`;
}

function freeLegacyEmail(canonical, id) {
  const taken = database.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE');
  const tokens = [String(id)];
  for (let n = 1; n <= 1000; n += 1) tokens.push(`${id}n${n}`);
  for (const token of tokens) {
    const candidate = legacyCollisionEmail(canonical, token);
    const row = taken.get(candidate);
    if (!row || Number(row.id) === Number(id)) return candidate;
  }
  return null;
}

function preferCanonicalOwner(left, right) {
  const leftVerified = Number(left.verified) === 1 ? 1 : 0;
  const rightVerified = Number(right.verified) === 1 ? 1 : 0;
  if (leftVerified !== rightVerified) return rightVerified - leftVerified;
  const leftCreated = String(left.created_at || '');
  const rightCreated = String(right.created_at || '');
  if (leftCreated !== rightCreated) return leftCreated < rightCreated ? -1 : 1;
  return Number(left.id) - Number(right.id);
}

function migrateCanonicalEmails() {
  const users = database.prepare('SELECT id, email, verified, created_at, password_hash FROM users').all();
  const groups = new Map();
  for (const row of users) {
    const next = canonicalEmail(row.email);
    if (!next || !validEmail(next)) {
      console.warn(`Uyarı: kullanıcı ${row.id} e-postası kanonik biçime çevrilemedi. Satır ve parolası olduğu gibi bırakıldı.`);
      continue;
    }
    if (!groups.has(next)) groups.set(next, []);
    groups.get(next).push(row);
  }
  const updateUserEmail = database.prepare('UPDATE users SET email = ? WHERE id = ?');
  for (const [canonical, group] of groups) {
    group.sort(preferCanonicalOwner);
    const winner = group[0];
    const losers = group.slice(1);
    if (losers.length === 0) {
      if (String(winner.email) !== canonical) updateUserEmail.run(canonical, winner.id);
      continue;
    }
    database.exec('BEGIN');
    try {
      for (const loser of losers) {
        const flagged = freeLegacyEmail(canonical, loser.id);
        if (!flagged) {
          console.warn(`Uyarı: e-posta göçü çakışması. id=${loser.id} için boş bir legacy adresi bulunamadı. "${loser.email}" olduğu gibi bırakıldı; sunucu açılmaya devam ediyor.`);
          continue;
        }
        if (String(loser.email) === flagged) continue;
        console.warn(`Uyarı: e-posta göçü çakışması. ${canonical} adresi id=${winner.id} hesabında bırakıldı (doğrulanmış=${Number(winner.verified) === 1 ? 'evet' : 'hayır'}). id=${loser.id} hesabının adresi "${loser.email}" yerine "${flagged}" yapıldı. Parola ve profil verisi değiştirilmedi.`);
        updateUserEmail.run(flagged, loser.id);
      }
      if (String(winner.email) !== canonical) updateUserEmail.run(canonical, winner.id);
      database.exec('COMMIT');
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      console.warn(`Uyarı: e-posta göçü çakışması çözülemedi (${canonical}). Hesaplar değiştirilmeden bırakıldı ve sunucu açılıyor: ${redact(error.message)}`);
    }
  }
  for (const [table, idColumn] of [['pending_registrations', 'id'], ['verification_sends', 'id'], ['password_reset_sends', 'id']]) {
    const rows = database.prepare(`SELECT ${idColumn} AS id, email FROM ${table}`).all();
    const update = database.prepare(`UPDATE ${table} SET email = ? WHERE ${idColumn} = ?`);
    for (const row of rows) {
      const next = canonicalEmail(row.email);
      if (!next || !validEmail(next) || next === String(row.email || '')) continue;
      update.run(next, row.id);
    }
  }
}

try {
  migrateCanonicalEmails();
} catch (error) {
  console.warn(`Uyarı: e-posta göçü tamamlanamadı. Sunucu açılıyor: ${redact(error.message)}`);
}

function clientAddress(request) {
  const socketIp = request.socket?.remoteAddress || '';
  if (!trustProxyEnabled()) return socketIp || 'unknown';
  const header = request.headers['x-forwarded-for'];
  if (typeof header !== 'string') return socketIp || 'unknown';
  const hops = header.split(',').map(part => part.trim()).filter(Boolean);
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index].replace(/^::ffff:/i, '');
    if (net.isIP(hop)) return hop;
  }
  return socketIp || 'unknown';
}

function anonymousFailureKey(email, ip) {
  return `${email}\n${ip}`;
}

function pruneStampMap(map, windowMs, now = Date.now()) {
  for (const [key, stamps] of map) {
    const recent = stamps.filter(timestamp => now - timestamp < windowMs);
    if (recent.length === 0) map.delete(key);
    else if (recent.length !== stamps.length) map.set(key, recent);
  }
  while (map.size > maxTrackedFailureKeys) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function recentAnonymousFailures(key, now) {
  const recent = (anonymousVerifyFailures.get(key) || []).filter(timestamp => now - timestamp < anonymousVerifyWindowMs);
  if (recent.length === 0) anonymousVerifyFailures.delete(key);
  else anonymousVerifyFailures.set(key, recent);
  return recent;
}

function anonymousVerifyBlocked(email, ip) {
  const now = Date.now();
  const byIp = recentAnonymousFailures(anonymousFailureKey(email, ip), now);
  const byEmail = recentAnonymousFailures(`email:${email}`, now);
  return byIp.length >= maxVerificationAttempts || byEmail.length >= maxVerificationAttempts;
}

function recordAnonymousVerifyFailure(email, ip) {
  const now = Date.now();
  if (anonymousVerifyFailures.size > 1024) pruneStampMap(anonymousVerifyFailures, anonymousVerifyWindowMs, now);
  for (const key of [anonymousFailureKey(email, ip), `email:${email}`]) {
    const recent = recentAnonymousFailures(key, now);
    recent.push(now);
    anonymousVerifyFailures.set(key, recent);
  }
}

function scryptLimitError() {
  const error = new Error('Çok fazla deneme yapıldı. Kısa bir süre sonra tekrar deneyin.');
  error.status = 429;
  return error;
}

function pumpScryptQueue() {
  while (scryptQueue.length && scryptActive < scryptParallel) scryptQueue.shift()();
}

function acquireScryptSlot(ip) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const recent = (scryptIpHits.get(ip) || []).filter(timestamp => now - timestamp < scryptPerIpWindowMs);
    if (recent.length >= scryptPerIpLimit) {
      scryptIpHits.set(ip, recent);
      reject(scryptLimitError());
      return;
    }
    recent.push(now);
    scryptIpHits.set(ip, recent);
    const held = scryptInFlightByIp.get(ip) || 0;
    if (held >= scryptPerIpInFlight || (scryptActive >= scryptParallel && scryptQueue.length >= scryptQueueMax)) {
      reject(scryptLimitError());
      return;
    }
    if (scryptIpHits.size > maxTrackedFailureKeys) {
      const oldest = scryptIpHits.keys().next().value;
      scryptIpHits.delete(oldest);
    }
    scryptInFlightByIp.set(ip, held + 1);
    const release = () => {
      scryptActive = Math.max(0, scryptActive - 1);
      const left = (scryptInFlightByIp.get(ip) || 1) - 1;
      if (left <= 0) scryptInFlightByIp.delete(ip);
      else scryptInFlightByIp.set(ip, left);
      pumpScryptQueue();
    };
    const start = () => {
      scryptActive += 1;
      resolve(release);
    };
    if (scryptActive < scryptParallel) start();
    else scryptQueue.push(start);
  });
}

async function runScrypt(password, salt, ip) {
  const release = await acquireScryptSlot(ip || 'unknown');
  try {
    return await scrypt(password, salt, 64);
  } finally {
    release();
  }
}

async function consumePasswordWork(password, ip) {
  const material = typeof password === 'string' && password.length > 0 && password.length <= 128
    ? password
    : 'placeholder-password';
  await runScrypt(material, dummyVerifySalt, ip);
}

function validUsername(username) {
  return typeof username === 'string' && username.trim().length >= 2 && username.trim().length <= 32 && !/[\u0000-\u001f\u007f<>]/.test(username);
}

function plainText(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[<>]/g, '').trim();
}

function imageBytesMatch(type, bytes) {
  if (type === 'png') {
    return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  }
  if (type === 'jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'gif') {
    const head = bytes.subarray(0, 6).toString('ascii');
    return head === 'GIF87a' || head === 'GIF89a';
  }
  if (type === 'webp') {
    return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function validAvatarData(avatarData) {
  if (avatarData === null || avatarData === undefined || avatarData === '') return null;
  if (typeof avatarData !== 'string' || avatarData.length > 700000) return undefined;
  const match = avatarData.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return undefined;
  const imageBytes = Buffer.from(match[2], 'base64');
  if (!imageBytes.length || imageBytes.length > maxAvatarBytes || !imageBytesMatch(match[1], imageBytes)) return undefined;
  return avatarData;
}

function sanitizeStored(value, key = '') {
  if (typeof value === 'string') {
    if (key === 'logo' || key === 'avatarData' || key === 'avatar') return validAvatarData(value) || '';
    if (value.startsWith('data:')) return '';
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[<>]/g, '');
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map(item => sanitizeStored(item));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [childKey, child] of Object.entries(value)) copy[childKey] = sanitizeStored(child, childKey);
    return copy;
  }
  return null;
}

function userRank(user) {
  if (['admin', 'moderator', 'support', 'player'].includes(user?.rank)) return user.rank;
  if (user?.id) {
    try {
      const row = database.prepare('SELECT role FROM user_roles WHERE user_id = ?').get(user.id);
      if (row?.role) return row.role;
    } catch {}
  }
  return 'player';
}

function userRole(user) {
  const rank = userRank(user);
  if (rank === 'admin' || rank === 'moderator' || rank === 'support') return rank;
  if (user?.role === 'modder') return 'modder';
  return 'user';
}

function attachRank(row) {
  if (!row) return row;
  const rank = row.rank || ensureRank(database, row);
  let totpEnabled = Number(row.totp_enabled) === 1;
  if (row.totp_enabled === undefined) {
    const security = database.prepare('SELECT totp_enabled FROM user_security WHERE user_id = ?').get(row.id);
    totpEnabled = Number(security?.totp_enabled) === 1;
  }
  return { ...row, id: asUserId(row.id) || row.id, rank, totpEnabled };
}

function purgeExpiredUnverifiedAccounts() {
  const cutoff = new Date(Date.now() - unverifiedAccountLifetime).toISOString();
  purgeExpiredUnverifiedUsers.run(cutoff);
  purgeExpiredPendingRegistrations.run(cutoff);
  purgeOldVerificationSends.run(Date.now() - unverifiedAccountLifetime);
}

purgeExpiredUnverifiedAccounts();
const unverifiedCleanupTimer = setInterval(purgeExpiredUnverifiedAccounts, 60 * 60 * 1000);
unverifiedCleanupTimer.unref();

function buyerBadge(count) {
  const tiers = [
    { min: 20, name: 'Paket efsanesi', tier: 5 },
    { min: 10, name: 'Paket canavarı', tier: 4 },
    { min: 5, name: 'Paket ustası', tier: 3 },
    { min: 3, name: 'Paketçi', tier: 2 },
    { min: 1, name: 'Paket yolcusu', tier: 1 }
  ];
  return tiers.find(item => count >= item.min) || null;
}

function confirmedPurchaseCount(userId) {
  const id = asUserId(userId);
  if (!id) return 0;
  const row = database.prepare("SELECT COUNT(*) AS total FROM orders WHERE user_id = ? AND status = 'confirmed'").get(id);
  return Number(row?.total || 0);
}

function publicUser(user) {
  const rank = userRank(user);
  const role = userRole({ ...user, rank });
  const purchaseCount = confirmedPurchaseCount(user?.id);
  const accountBan = Object.hasOwn(user || {}, 'ban')
    ? (user.ban || null)
    : (accountIsBanned(user) ? banInfo(expireTemporaryBan(user), 'account') : null);
  return {
    email: user.email,
    username: user.username,
    avatarData: validAvatarData(user.avatar_data) || null,
    role,
    rank,
    isAdmin: rank === 'admin',
    isModerator: rank === 'moderator',
    isSupport: rank === 'support',
    isModder: role === 'modder',
    twoFactorEnabled: Boolean(user.totpEnabled),
    twoFactorRequired: rank === 'admin' || rank === 'moderator',
    purchaseCount,
    buyerBadge: buyerBadge(purchaseCount),
    isBanned: Boolean(accountBan),
    banReason: accountBan?.banReason || null,
    banType: accountBan?.banType || null,
    bannedUntil: accountBan?.bannedUntil || null
  };
}

function asUserId(value) {
  if (typeof value === 'bigint') value = Number(value);
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function normalizeDeviceId(value) {
  if (typeof value !== 'string') return '';
  const deviceId = value.trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(deviceId) ? deviceId : '';
}

function accountIsBanned(user) {
  return Boolean(user?.isBanned || user?.banned);
}

function expireTemporaryBan(user) {
  if (!user || !accountIsBanned(user)) return user;
  if (user.banType !== 'TEMPORARY' || !user.bannedUntil) return user;
  const until = Date.parse(user.bannedUntil);
  if (!Number.isFinite(until) || until > Date.now()) return user;
  clearUserBan.run(user.id);
  return {
    ...user,
    banned: 0,
    isBanned: 0,
    banReason: null,
    banNote: null,
    banType: 'PERMANENT',
    bannedAt: null,
    bannedUntil: null,
    isDeviceBanned: 0
  };
}

function banInfo(user, source) {
  return {
    source,
    banType: user.banType === 'TEMPORARY' ? 'TEMPORARY' : 'PERMANENT',
    banReason: typeof user.banReason === 'string' && user.banReason.trim() ? user.banReason.trim() : 'Sebep belirtilmedi',
    bannedUntil: user.banType === 'TEMPORARY' && user.bannedUntil ? user.bannedUntil : null
  };
}

function activeDeviceBan(deviceId, excludeUserId = 0) {
  if (!deviceId) return null;
  const rows = usersByDeviceId.all(deviceId);
  for (const row of rows) {
    if (row.id === excludeUserId) continue;
    const current = expireTemporaryBan(row);
    if (current.isDeviceBanned) return banInfo(current, 'device');
  }
  return null;
}

function getBanBlock(user, incomingDeviceId = '') {
  if (!user) return null;
  const current = expireTemporaryBan(user);
  if (accountIsBanned(current)) return banInfo(current, 'account');
  return activeDeviceBan(incomingDeviceId || current.deviceId, current.id);
}

function sendBanBlocked(response, ban) {
  const untilText = ban.bannedUntil
    ? ` Ban bitiş: ${new Date(ban.bannedUntil).toLocaleString('tr-TR')}.`
    : '';
  const kind = ban.source === 'device' ? 'Bu cihaz' : 'Bu hesap';
  sendJson(response, 403, {
    ok: false,
    banned: true,
    banType: ban.banType,
    banReason: ban.banReason,
    bannedUntil: ban.bannedUntil,
    error: `${kind} yönetici tarafından engellenmiş. Sebep: ${ban.banReason}.${untilText}`
  });
}

function persistDeviceId(userId, deviceId) {
  if (deviceId) saveUserDeviceId.run(deviceId, userId);
}

function publicBanState(account) {
  const current = expireTemporaryBan(account);
  const banned = accountIsBanned(current);
  return {
    banned,
    isBanned: banned,
    banReason: banned ? current.banReason : null,
    banNote: banned ? current.banNote : null,
    banType: banned ? (current.banType === 'TEMPORARY' ? 'TEMPORARY' : 'PERMANENT') : null,
    bannedUntil: banned ? current.bannedUntil : null,
    isDeviceBanned: banned ? Boolean(current.isDeviceBanned) : false
  };
}

async function sendVerificationEmail(email, code) {
  await sendMail({
    to: email,
    subject: 'Turnuva hesabı e-posta doğrulama kodu',
    text: `E-posta doğrulama kodunuz: ${code}\nKod 10 dakika geçerlidir.`,
    html: `<p>E-posta doğrulama kodunuz:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>Kod 10 dakika geçerlidir.</p>`
  });
}

function configuredAppBaseUrl() {
  const raw = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
  if (isHosted() && parsed.protocol !== 'https:') return '';
  return raw;
}

const forgotPasswordReceipt = {
  ok: true,
  message: 'E-posta adresin sistemde varsa şifre sıfırlama bağlantısı gönderildi.'
};

async function sendPasswordResetEmail(email, token, baseUrl) {
  const link = `${baseUrl}/?reset=${encodeURIComponent(token)}`;
  await sendMail({
    to: email,
    subject: 'Omni şifre sıfırlama',
    text: `Şifreni sıfırlamak için bu bağlantıyı aç:\n${link}\n\nBağlantı 30 dakika geçerlidir ve tek kullanımlıktır. Bu isteği sen yapmadıysan bu iletiyi yok say.`,
    html: `<p>Şifreni sıfırlamak için bu bağlantıyı aç:</p><p><a href="${link}">${link}</a></p><p>Bağlantı 30 dakika geçerlidir ve tek kullanımlıktır. Bu isteği sen yapmadıysan bu iletiyi yok say.</p>`
  });
}

function requestBodyLimit(pathname, user) {
  // 20 MB yalnız oturum açıkken: hesap kaydı ve yedek geri yükleme.
  // Takım logoları bu gövdede birikir; avatar tek başına en fazla 512 KB.
  // Paket kadrosunda resim yok (64 takım × 32 oyuncu metni 1 MB altında).
  if (user && pathname === '/api/account/data') return accountDataBodyLimit;
  return defaultBodyLimit;
}

async function readJsonBody(request, response, maxBytes) {
  let raw;
  try {
    raw = await readRequestBody(request, maxBytes);
  } catch (error) {
    sendJson(response, error.status || 400, { ok: false, error: error.message });
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    sendJson(response, 400, { ok: false, error: 'Geçersiz JSON verisi' });
    return null;
  }
}

function requireSameOrigin(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    if (new URL(origin).host === request.headers.host) return true;
  } catch {}
  sendJson(response, 403, { ok: false, error: 'İstek kaynağı reddedildi' });
  return false;
}

function enforceRateLimit(request, response, action, limit, windowMs) {
  const key = `${action}:${clientAddress(request)}`;
  const now = Date.now();
  if (authRateLimits.size > 1024) pruneStampMap(authRateLimits, 15 * 60 * 1000, now);
  const recent = (authRateLimits.get(key) || []).filter(timestamp => now - timestamp < windowMs);
  if (recent.length >= limit) {
    authRateLimits.set(key, recent);
    sendJson(response, 429, { ok: false, error: 'Çok fazla deneme yapıldı. Daha sonra tekrar deneyin.' });
    return false;
  }
  recent.push(now);
  authRateLimits.set(key, recent);
  return true;
}

function inspectSession(request) {
  const token = getCookie(request, 'turnuva_session');
  if (!token) return { user: null, ban: null };
  const tokenHash = hashToken(token);
  const session = sessionForToken.get(tokenHash);
  if (!session || !session.verified || session.expires_at <= Date.now()) {
    deleteSession.run(tokenHash);
    return { user: null, ban: null };
  }
  const current = expireTemporaryBan(session);
  const accountBan = accountIsBanned(current) ? banInfo(current, 'account') : null;
  const deviceBan = accountBan ? null : activeDeviceBan(current.deviceId, current.id);
  if (deviceBan) {
    deleteSession.run(tokenHash);
    return { user: null, ban: deviceBan };
  }
  const ranked = attachRank(current);
  return {
    user: {
      id: asUserId(ranked.id),
      email: ranked.email,
      username: ranked.username,
      avatar_data: ranked.avatar_data,
      role: ranked.role,
      rank: ranked.rank,
      totpEnabled: ranked.totpEnabled,
      pending2fa: Number(current.pending_2fa) === 1,
      tokenHash,
      ban: accountBan
    },
    ban: accountBan
  };
}

function findSession(request) {
  return inspectSession(request).user;
}

function requireSession(request, response, allowBanned = false) {
  const { user, ban } = inspectSession(request);
  if (!user && ban) {
    sendBanBlocked(response, ban);
    return null;
  }
  if (user && ban && !allowBanned) {
    sendBanBlocked(response, ban);
    return null;
  }
  if (user?.pending2fa) {
    sendJson(response, 403, {
      ok: false,
      error: 'Giriş için iki adımlı doğrulama kodu gerekli',
      code: 'pending_2fa'
    });
    return null;
  }
  if (user) return user;
  sendJson(response, 401, { ok: false, error: 'Oturum açmanız gerekiyor' });
  return null;
}

function sendTwoFactorRequired(response) {
  sendJson(response, 403, {
    ok: false,
    error: 'Bu işlem için iki adımlı doğrulama kurulmalı',
    code: '2fa_required',
    setupPath: '/api/account/2fa/setup'
  });
}

function requireRank(request, response, minRank) {
  const user = requireSession(request, response);
  if (!user) return null;
  const levels = { player: 1, support: 2, moderator: 3, admin: 4 };
  if ((levels[user.rank] || 0) < (levels[minRank] || 99)) {
    sendJson(response, 403, {
      ok: false,
      error: user.role === 'modder' || user.rank === 'moderator' ? 'Bu rütbenin bu yetkisi yok' : 'Bu işlem için yetki gerekiyor'
    });
    return null;
  }
  if ((user.rank === 'admin' || user.rank === 'moderator') && !user.totpEnabled) {
    sendTwoFactorRequired(response);
    return null;
  }
  return user;
}

function requireAdmin(request, response) {
  return requireRank(request, response, 'admin');
}

function requireStaff(request, response) {
  const user = requireSession(request, response);
  if (!user) return null;
  if (user.rank === 'admin') {
    if (!user.totpEnabled) {
      sendTwoFactorRequired(response);
      return null;
    }
    return user;
  }
  if (user.role === 'modder') return user;
  sendJson(response, 403, { ok: false, error: 'Bu işlem için yetki gerekiyor' });
  return null;
}

function validatePackage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Paket verisi geçersiz'), { status: 400 });
  }
  const title = typeof body.title === 'string' ? plainText(body.title) : '';
  let description = body.description === undefined ? '' : body.description;
  const price = body.price;
  const stock = body.stock;
  const currency = body.currency;
  const config = body.config;
  if (title.length < 2 || title.length > 80) throw Object.assign(new Error('Paket adı 2-80 karakter olmalı'), { status: 400 });
  if (typeof description !== 'string') throw Object.assign(new Error('Açıklama metin olmalı'), { status: 400 });
  description = plainText(description);
  if (description.length > 500) throw Object.assign(new Error('Açıklama en fazla 500 karakter olabilir'), { status: 400 });
  if (!Number.isFinite(price) || price < 0 || price > 1_000_000_000) throw Object.assign(new Error('Geçerli bir paket fiyatı girin'), { status: 400 });
  if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) throw Object.assign(new Error('Stok 0-1.000.000 arasında tam sayı olmalı'), { status: 400 });
  if (!['USD', 'EUR'].includes(currency)) throw Object.assign(new Error('Para birimi geçersiz'), { status: 400 });
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Object.assign(new Error('Lig ayarları geçersiz'), { status: 400 });

  const { format } = config;
  const { totalTeams, matchesPerPair, pointsWin, pointsDraw, pointsLoss, winBudgetReward } = config;
  const groupCount = config.groupCount === undefined ? 0 : config.groupCount;
  const teamsPerGroup = config.teamsPerGroup === undefined ? 0 : config.teamsPerGroup;
  if (!['league', 'knockout', 'group_knockout'].includes(format)) throw Object.assign(new Error('Turnuva formatı geçersiz'), { status: 400 });
  if (!Number.isInteger(totalTeams) || totalTeams < 2 || totalTeams > 64) throw Object.assign(new Error('Takım sayısı 2-64 arasında tam sayı olmalı'), { status: 400 });
  if (!Number.isInteger(matchesPerPair) || matchesPerPair < 1 || matchesPerPair > 4) throw Object.assign(new Error('Devre sayısı 1-4 arasında olmalı'), { status: 400 });
  if (![pointsWin, pointsDraw, pointsLoss].every(value => Number.isInteger(value) && value >= 0 && value <= 100)) {
    throw Object.assign(new Error('Puan değerleri 0-100 arasında tam sayı olmalı'), { status: 400 });
  }
  if (!Number.isFinite(winBudgetReward) || winBudgetReward < 0 || winBudgetReward > 1_000_000) {
    throw Object.assign(new Error('Galibiyet bütçe ödülü 0-1.000.000 arasında olmalı'), { status: 400 });
  }
  if (format === 'league' && totalTeams > 24) throw Object.assign(new Error('Lig formatında takım sayısı en fazla 24 olabilir'), { status: 400 });
  if (format === 'knockout' && (![4, 8, 16, 32].includes(totalTeams))) {
    throw Object.assign(new Error('Eleme formatında takım sayısı 4, 8, 16 veya 32 olmalı'), { status: 400 });
  }
  if (format === 'group_knockout' && (
    !Number.isInteger(groupCount) || groupCount < 2 || groupCount > 16 ||
    !Number.isInteger(teamsPerGroup) || teamsPerGroup < 2 || teamsPerGroup > 16 ||
    groupCount * teamsPerGroup !== totalTeams
  )) throw Object.assign(new Error('Grup sayısı ve gruptaki takım sayısı toplam takım sayısıyla uyuşmuyor'), { status: 400 });
  if (config.genGrowthMode !== undefined && !['automatic', 'manual'].includes(config.genGrowthMode)) {
    throw Object.assign(new Error('GEN gelişim ayarı geçersiz'), { status: 400 });
  }
  if (config.autoTransfers !== undefined && typeof config.autoTransfers !== 'boolean') {
    throw Object.assign(new Error('Otomatik transfer ayarı geçersiz'), { status: 400 });
  }
  if (body.published !== undefined && typeof body.published !== 'boolean') {
    throw Object.assign(new Error('Yayın durumu geçersiz'), { status: 400 });
  }

  return {
    title,
    description,
    price,
    currency,
    stock,
    config: {
      format,
      totalTeams,
      matchesPerPair,
      pointsWin,
      pointsDraw,
      pointsLoss,
      winBudgetReward,
      genGrowthMode: config.genGrowthMode === 'manual' ? 'manual' : 'automatic',
      autoTransfers: config.autoTransfers === true,
      ...(format === 'group_knockout' ? { groupCount, teamsPerGroup } : {})
    },
    published: body.published !== false
  };
}

const ROSTER_SLOTS = [
  ...Array.from({ length: 6 }, () => 'GK'),
  ...Array.from({ length: 10 }, () => 'DEF'),
  ...Array.from({ length: 10 }, () => 'MID'),
  ...Array.from({ length: 6 }, () => 'FWD')
];

function cleanRosterPlayer(player, index) {
  const expected = ROSTER_SLOTS[index];
  const name = typeof player?.name === 'string' ? plainText(player.name) : '';
  const age = Number(player?.age);
  const gen = Number(player?.gen);
  const marketValue = Number(player?.marketValue);
  const shirtRaw = player?.shirtNumber;
  const shirtNumber = shirtRaw === '' || shirtRaw === null || shirtRaw === undefined ? null : Number(shirtRaw);
  if (player?.position && player.position !== expected) {
    throw Object.assign(new Error('Oyuncu mevkii kadro sırasıyla uyuşmuyor'), { status: 400 });
  }
  if (name && (name.length < 2 || name.length > 40)) throw Object.assign(new Error('Oyuncu adı 2-40 karakter olmalı'), { status: 400 });
  if (!Number.isInteger(age) || age < 15 || age > 45) throw Object.assign(new Error('Oyuncu yaşı 15-45 arasında olmalı'), { status: 400 });
  if (!Number.isInteger(gen) || gen < 1 || gen > 100) throw Object.assign(new Error('GEN 1-100 arasında olmalı'), { status: 400 });
  if (!Number.isFinite(marketValue) || marketValue < 0 || marketValue > 1_000_000_000) {
    throw Object.assign(new Error('Piyasa değeri geçersiz'), { status: 400 });
  }
  if (shirtNumber !== null && (!Number.isInteger(shirtNumber) || shirtNumber < 1 || shirtNumber > 99)) {
    throw Object.assign(new Error('Forma numarası 1-99 arasında olmalı'), { status: 400 });
  }
  return { name, position: expected, age, gen, marketValue, shirtNumber };
}

function normalizeRoster(roster, totalTeams, strict) {
  if (!Array.isArray(roster) || roster.length !== totalTeams) {
    throw Object.assign(new Error(`Kadroda ${totalTeams} takım olmalı`), { status: 400 });
  }
  const teamNames = new Set();
  return roster.map(team => {
    const name = typeof team?.name === 'string' ? plainText(team.name) : '';
    if (strict && (name.length < 2 || name.length > 40)) throw Object.assign(new Error('Takım adı 2-40 karakter olmalı'), { status: 400 });
    if (name && (name.length < 2 || name.length > 40)) throw Object.assign(new Error('Takım adı 2-40 karakter olmalı'), { status: 400 });
    const key = name.toLocaleLowerCase('tr-TR');
    if (name && teamNames.has(key)) throw Object.assign(new Error('Takım adları tekrar edemez'), { status: 400 });
    if (name) teamNames.add(key);
    if (!Array.isArray(team?.players) || team.players.length !== ROSTER_SLOTS.length) {
      throw Object.assign(new Error('Her takımda 32 oyuncu alanı olmalı'), { status: 400 });
    }
    const players = team.players.map(cleanRosterPlayer);
    const shirts = new Set();
    for (const player of players) {
      if (strict && player.name.length < 2) throw Object.assign(new Error(`${name || 'Takım'} kadrosunda boş oyuncu var`), { status: 400 });
      if (player.shirtNumber !== null) {
        if (shirts.has(player.shirtNumber)) throw Object.assign(new Error(`${name || 'Takım'} kadrosunda forma numarası tekrar ediyor`), { status: 400 });
        shirts.add(player.shirtNumber);
      }
    }
    return { name, players };
  });
}

function packageFromRow(row) {
  return {
    id: row.id,
    title: plainText(row.title || ''),
    description: plainText(row.description || ''),
    price: row.price,
    currency: row.currency,
    stock: row.stock,
    config: JSON.parse(row.config),
    published: Boolean(row.published),
    approvalStatus: ['pending', 'rejected', 'draft'].includes(row.approval_status) ? row.approval_status : 'approved',
    roster: parseRoster(row.roster),
    submittedBy: row.submitted_by ? asUserId(row.submitted_by) : null,
    submitterName: row.submitter_username ? plainText(row.submitter_username) : null
  };
}

function parseRoster(value) {
  if (!value) return null;
  try {
    const roster = JSON.parse(value);
    return Array.isArray(roster) ? roster : null;
  } catch {
    return null;
  }
}

const packageListSql = `
  SELECT packages.*, users.username AS submitter_username, users.email AS submitter_email
  FROM packages LEFT JOIN users ON users.id = packages.submitted_by
`;

function normalizeIban(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

function formatIban(iban) {
  return normalizeIban(iban).replace(/(.{4})/g, '$1 ').trim();
}

function validTrIban(iban) {
  if (!/^TR\d{24}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, char => String(char.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

function shopSettings() {
  return database.prepare('SELECT account_name, iban, bank_name, note FROM shop_settings WHERE id = 1').get() || {
    account_name: '',
    iban: '',
    bank_name: '',
    note: ''
  };
}

function paymentInstructions() {
  const settings = shopSettings();
  const iban = normalizeIban(settings.iban);
  if (!settings.account_name || !validTrIban(iban)) return null;
  return {
    accountName: settings.account_name,
    iban: formatIban(iban),
    bankName: settings.bank_name || '',
    note: settings.note || ''
  };
}

function orderFromRow(row) {
  return {
    id: asUserId(row.id),
    packageId: row.package_id,
    packageTitle: row.package_title,
    price: row.price,
    currency: row.currency,
    referenceCode: row.reference_code,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    username: row.username || null,
    email: row.email || null
  };
}

function createOrderReference() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let code = 'TY-';
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return code;
}

function issueSession(response, userId, request, pending = false) {
  const token = crypto.randomBytes(32).toString('base64url');
  const lifetime = pending ? PENDING_2FA_MS : sessionLifetime;
  insertSession.run(hashToken(token), userId, Date.now() + lifetime, pending ? 1 : 0);
  setSessionCookie(response, token, lifetime / 1000, request);
}

function claimPendingRegistration(pending, deviceId) {
  const chosenDevice = deviceId || pending.device_id || null;
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = database.prepare('SELECT id, verified FROM users WHERE email = ? COLLATE NOCASE').get(pending.email);
    if (current?.verified) {
      database.exec('ROLLBACK');
      return { conflict: true };
    }
    let userId;
    if (!current) {
      const result = insertVerifiedUser.run(
        pending.email, pending.username, pending.avatar_data, pending.password_hash, pending.password_salt,
        chosenDevice, new Date().toISOString()
      );
      userId = Number(result.lastInsertRowid);
    } else {
      const updated = applyPendingRegistration.run(
        pending.username, pending.avatar_data, pending.password_hash, pending.password_salt, chosenDevice, current.id
      );
      if (Number(updated.changes) !== 1) {
        database.exec('ROLLBACK');
        return { conflict: true };
      }
      userId = current.id;
    }
    deletePendingByEmail.run(pending.email);
    deleteVerificationCodes.run(userId);
    deleteUserSessions.run(userId);
    database.exec('COMMIT');
    return { userId };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    if (isUniqueConstraintError(error)) return { conflict: true };
    throw error;
  }
}

async function handleAuthRequest(request, response, pathname) {
  if (request.method === 'GET' && pathname === '/api/auth/session') {
    const { user, ban } = inspectSession(request);
    if (ban) {
      sendBanBlocked(response, ban);
      return;
    }
    if (user?.pending2fa) {
      sendJson(response, 200, { pending2fa: true, user: null });
      return;
    }
    sendJson(response, 200, { user: user ? publicUser(user) : null });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/auth/2fa') {
    if (!requireSameOrigin(request, response)) return;
    if (!enforceRateLimit(request, response, pathname, 10, 5 * 60 * 1000)) return;
    const { user } = inspectSession(request);
    if (!user?.pending2fa) {
      sendJson(response, 401, { ok: false, error: 'Doğrulama bekleyen oturum yok' });
      return;
    }
    const body = await readJsonBody(request, response, requestBodyLimit(pathname, null));
    if (!body) return;
    try {
      const { verifyFactor } = require('./lib/ranks');
      const result = verifyFactor(database, user, body.code, totpKey);
      const lifetime = Date.now() + sessionLifetime;
      const updated = promotePendingSession.run(lifetime, user.tokenHash);
      if (!updated.changes) {
        sendJson(response, 401, { ok: false, error: 'Doğrulama bekleyen oturum yok' });
        return;
      }
      setSessionCookie(response, getCookie(request, 'turnuva_session'), sessionLifetime / 1000, request);
      sendJson(response, 200, { ok: true, method: result.method, user: publicUser({ ...user, pending2fa: false }) });
    } catch (error) {
      const status = Number(error.status) || 500;
      sendJson(response, status, { ok: false, error: status === 500 ? 'Sunucu isteği tamamlayamadı' : error.message });
    }
    return;
  }
  if (request.method === 'POST' && !requireSameOrigin(request, response)) return;
  const limits = {
    '/api/auth/register': [5, 15 * 60 * 1000],
    '/api/auth/login': [10, 15 * 60 * 1000],
    '/api/auth/logout': [20, 15 * 60 * 1000],
    '/api/auth/forgot-password': [5, 15 * 60 * 1000],
    '/api/auth/reset-password': [10, 15 * 60 * 1000]
  }[pathname];
  if (request.method === 'POST' && limits && !enforceRateLimit(request, response, pathname, limits[0], limits[1])) return;

  if (request.method === 'POST' && pathname === '/api/auth/register') {
    const body = await readJsonBody(request, response, requestBodyLimit(pathname, null));
    if (!body) return;
    const email = canonicalEmail(body.email);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const confirmation = typeof body.confirmation === 'string' ? body.confirmation : '';
    const deviceId = normalizeDeviceId(body.deviceId);
    const avatarData = validAvatarData(body.avatarData);
    const deviceBan = activeDeviceBan(deviceId);
    if (deviceBan) {
      sendBanBlocked(response, deviceBan);
      return;
    }
    if (!validEmail(email)) {
      sendJson(response, 400, { ok: false, error: 'Geçerli bir e-posta adresi girin' });
      return;
    }
    if (!validUsername(username)) {
      sendJson(response, 400, { ok: false, error: 'Kullanıcı adı 2-32 karakter olmalı' });
      return;
    }
    if (avatarData === undefined) {
      sendJson(response, 400, { ok: false, error: 'Profil fotoğrafı geçersiz veya 512 KB sınırını aşıyor' });
      return;
    }
    if (password.length < 8 || password.length > 128) {
      sendJson(response, 400, { ok: false, error: 'Şifre en az 8, en fazla 128 karakter olmalı' });
      return;
    }
    if (password !== confirmation) {
      sendJson(response, 400, { ok: false, error: 'Şifre ve şifre onayı aynı olmalı' });
      return;
    }
    const kvkkAccepted = body.kvkkAccepted === true || body.kvkkAccepted === 'true' || body.kvkkAccepted === 'on' || body.kvkkAccepted === 1 || body.kvkkAccepted === '1';
    if (!kvkkAccepted) {
      sendJson(response, 400, { ok: false, error: "Kayıt için Aydınlatma Metni'ni okuduğunuzu onaylamanız gerekir" });
      return;
    }
    if (!mailConfigured()) {
      sendJson(response, 503, { ok: false, error: 'E-posta gönderimi şu an kullanılamıyor. Daha sonra tekrar dene.' });
      return;
    }
    purgeExpiredUnverifiedAccounts();
    const clientIp = clientAddress(request);
    const existingBefore = readUser.get(email);
    if (existingBefore?.verified) {
      await consumePasswordWork(password, clientIp);
      sendJson(response, 409, { ok: false, error: 'Bu e-posta zaten kayıtlı. Giriş yapın veya doğrulama kodunu yeniden isteyin.' });
      return;
    }
    const earlyBlock = verificationSendBlock(email);
    if (earlyBlock) {
      await consumePasswordWork(password, clientIp);
      sendJson(response, earlyBlock.status, { ok: false, error: earlyBlock.error });
      return;
    }
    const salt = crypto.randomBytes(16);
    const passwordHash = await runScrypt(password, salt, clientIp);
    const passwordHashHex = passwordHash.toString('hex');
    const saltHex = salt.toString('hex');
    const createdAt = new Date().toISOString();
    if (readUser.get(email)?.verified) {
      sendJson(response, 409, { ok: false, error: 'Bu e-posta zaten kayıtlı. Giriş yapın veya doğrulama kodunu yeniden isteyin.' });
      return;
    }
    let createdUserId = 0;
    if (!existingBefore) {
      try {
        const result = insertUnverifiedUser.run(email, username, avatarData, passwordHashHex, saltHex, deviceId || null, createdAt);
        createdUserId = Number(result.lastInsertRowid);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          sendJson(response, 409, { ok: false, error: 'Bu e-posta zaten kayıtlı' });
          return;
        }
        throw error;
      }
    } else {
      const sendBlock = verificationSendBlock(email);
      if (sendBlock) {
        sendJson(response, sendBlock.status, { ok: false, error: sendBlock.error });
        return;
      }
    }
    let pendingId = 0;
    const issued = issuePendingCode();
    try {
      const pending = insertPendingRegistration.run(
        email, username, avatarData, passwordHashHex, saltHex, deviceId || null,
        issued.registrationKey, issued.codeHash, issued.expiresAt, issued.now, createdAt
      );
      pendingId = Number(pending.lastInsertRowid);
      insertVerificationSend.run(email, issued.now);
      await sendVerificationEmail(email, issued.code);
    } catch (error) {
      if (pendingId) deletePendingById.run(pendingId);
      if (createdUserId) deleteUnverifiedUser.run(createdUserId);
      if (error.status) {
        sendJson(response, error.status, { ok: false, error: error.message });
      } else if (isUniqueConstraintError(error)) {
        sendJson(response, 409, { ok: false, error: 'Bu e-posta zaten kayıtlı' });
      } else {
        console.error('Hesap oluşturma başarısız:', error.code || error.name);
        sendJson(response, 500, { ok: false, error: 'Hesap oluşturulamadı' });
      }
      return;
    }
    sendJson(response, 201, { ok: true, verificationRequired: true, email });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/verify') {
    const body = await readJsonBody(request, response, requestBodyLimit(pathname, null));
    if (!body) return;
    const email = canonicalEmail(body.email);
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const deviceId = normalizeDeviceId(body.deviceId);
    const verifyFailure = { ok: false, error: 'Doğrulama kodu veya şifre hatalı' };
    const clientIp = clientAddress(request);
    purgeExpiredUnverifiedAccounts();
    if (!validEmail(email)) {
      await consumePasswordWork(password, clientIp);
      sendJson(response, 400, verifyFailure);
      return;
    }
    const pendingRows = readPendingByEmail.all(email);
    const now = Date.now();
    const passwordMatches = [];
    const passwordCheckable = typeof password === 'string' && password.length >= 8 && password.length <= 128;
    if (!pendingRows.length || !passwordCheckable) await consumePasswordWork(password, clientIp);
    if (passwordCheckable) {
      for (const row of pendingRows) {
        if (await pendingPasswordMatches(row, password, clientIp)) passwordMatches.push(row);
      }
    }
    if (!passwordMatches.length) {
      if (!anonymousVerifyBlocked(email, clientIp)) recordAnonymousVerifyFailure(email, clientIp);
      sendJson(response, 400, verifyFailure);
      return;
    }
    const codeMatch = passwordMatches.find(row =>
      row.expires_at > now && row.attempts < maxVerificationAttempts && pendingCodeMatches(row, code)
    );
    if (!codeMatch) {
      for (const row of passwordMatches) {
        if (row.expires_at > now) incrementPendingAttempts.run(row.id, maxVerificationAttempts);
      }
      sendJson(response, 400, verifyFailure);
      return;
    }
    const claimed = claimPendingRegistration(codeMatch, deviceId);
    if (claimed.conflict) {
      sendJson(response, 409, { ok: false, error: 'Bu e-posta zaten kayıtlı. Giriş yapın veya doğrulama kodunu yeniden isteyin.' });
      return;
    }
    const stored = attachRank(database.prepare('SELECT id, email, username, avatar_data, role, banned, isBanned, banReason, banType, bannedUntil, deviceId, isDeviceBanned FROM users WHERE id = ?').get(claimed.userId));
    try {
      ensureStartingOmni(database, stored, new Date().toISOString(), actingAdminEmail(stored));
    } catch (error) {
      console.error('Başlangıç Omni Dolar yazılamadı:', error.code || error.name);
    }
    const ban = getBanBlock(stored, deviceId);
    if (ban) {
      sendBanBlocked(response, ban);
      return;
    }
    issueSession(response, stored.id, request);
    sendJson(response, 200, { ok: true, user: publicUser(stored) });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/resend') {
    const body = await readJsonBody(request, response, requestBodyLimit(pathname, null));
    if (!body) return;
    const email = canonicalEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const resendReceipt = { ok: true, message: 'E-posta adresi kayıtlıysa yeni doğrulama kodu gönderildi' };
    const clientIp = clientAddress(request);
    purgeExpiredUnverifiedAccounts();
    if (!validEmail(email)) {
      await consumePasswordWork(password, clientIp);
      sendJson(response, 200, resendReceipt);
      return;
    }
    const user = readUser.get(email);
    const pendingRows = !user || user.verified ? [] : readPendingByEmail.all(email);
    const passwordCheckable = typeof password === 'string' && password.length >= 8 && password.length <= 128;
    let matched = null;
    if (!pendingRows.length || !passwordCheckable) await consumePasswordWork(password, clientIp);
    if (passwordCheckable) {
      for (let index = pendingRows.length - 1; index >= 0 && !matched; index -= 1) {
        if (await pendingPasswordMatches(pendingRows[index], password, clientIp)) matched = pendingRows[index];
      }
    }
    if (matched) {
      const reservation = reserveVerificationSend(email);
      if (!reservation.block) {
        try {
          const issued = issuePendingCode();
          updatePendingCode.run(issued.registrationKey, issued.codeHash, issued.expiresAt, reservation.now, matched.id);
          await sendVerificationEmail(email, issued.code);
        } catch (error) {
          try { deleteVerificationSend.run(reservation.id); } catch {}
          console.error('Doğrulama e-postası gönderilemedi:', error.code || error.name);
        }
      }
    }
    sendJson(response, 200, resendReceipt);
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJsonBody(request, response, requestBodyLimit(pathname, null));
    if (!body) return;
    const email = canonicalEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const deviceId = normalizeDeviceId(body.deviceId);
    const clientIp = clientAddress(request);
    const stored = database.prepare(`
      SELECT id, email, username, avatar_data, password_hash, password_salt, verified, role,
        banned, isBanned, banReason, banType, bannedUntil, deviceId, isDeviceBanned
      FROM users WHERE email = ? COLLATE NOCASE
    `).get(email);
    if (!stored || password.length > 128) {
      await consumePasswordWork(password, clientIp);
      sendJson(response, 401, { ok: false, error: 'E-posta veya şifre hatalı' });
      return;
    }
    const candidateHash = await runScrypt(password, Buffer.from(stored.password_salt, 'hex'), clientIp);
    const expectedHash = Buffer.from(stored.password_hash, 'hex');
    if (candidateHash.length !== expectedHash.length || !crypto.timingSafeEqual(candidateHash, expectedHash)) {
      sendJson(response, 401, { ok: false, error: 'E-posta veya şifre hatalı' });
      return;
    }
    persistDeviceId(stored.id, deviceId);
    const ban = getBanBlock({ ...stored, deviceId: deviceId || stored.deviceId }, deviceId);
    if (ban?.source === 'device') {
      sendBanBlocked(response, ban);
      return;
    }
    if (!stored.verified) {
      sendJson(response, 403, { ok: false, error: 'E-posta doğrulanmamış. Gelen kutunuzdaki kodu girin.' });
      return;
    }
    const ranked = attachRank(stored);
    if (ranked.totpEnabled) {
      issueSession(response, ranked.id, request, true);
      sendJson(response, 200, { ok: true, pending2fa: true, expiresIn: Math.floor(PENDING_2FA_MS / 1000) });
      return;
    }
    issueSession(response, ranked.id, request, false);
    sendJson(response, 200, { ok: true, user: publicUser({ ...ranked, ban: ban?.source === 'account' ? ban : null }) });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    const user = findSession(request);
    if (user) deleteSession.run(user.tokenHash);
    clearSessionCookie(response, request);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/forgot-password') {
    const body = await readJsonBody(request, response, requestBodyLimit(pathname, null));
    if (!body) return;
    const email = canonicalEmail(body.email);
    const baseUrl = configuredAppBaseUrl();
    const stored = validEmail(email)
      ? database.prepare('SELECT id, email, verified FROM users WHERE email = ? COLLATE NOCASE').get(email)
      : null;
    if (stored?.verified && mailConfigured() && baseUrl) {
      const now = Date.now();
      purgeOldPasswordResetSends.run(now - 60 * 60 * 1000);
      const hourly = Number(passwordResetSendCounts.get(now - 60 * 60 * 1000, stored.email)?.hourly || 0);
      if (hourly < maxPasswordResetEmailsPerHour) {
        purgeExpiredPasswordResetTokens.run(now);
        const token = crypto.randomBytes(32).toString('base64url');
        const tokenHash = hashToken(token);
        deletePasswordResetTokensForUser.run(stored.id);
        insertPasswordResetToken.run(tokenHash, stored.id, now + passwordResetLifetime);
        insertPasswordResetSend.run(stored.email, now);
        sendPasswordResetEmail(stored.email, token, baseUrl).catch(() => {
          deletePasswordResetToken.run(tokenHash);
        });
      }
    }
    sendJson(response, 200, forgotPasswordReceipt);
    return;
  }

  if (request.method === 'POST' && pathname === '/api/auth/reset-password') {
    const body = await readJsonBody(request, response, requestBodyLimit(pathname, null));
    if (!body) return;
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const confirmation = typeof body.confirmation === 'string' ? body.confirmation : '';
    if (password.length < 8 || password.length > 128) {
      sendJson(response, 400, { ok: false, error: 'Şifre en az 8, en fazla 128 karakter olmalı' });
      return;
    }
    if (password !== confirmation) {
      sendJson(response, 400, { ok: false, error: 'Şifre ve şifre onayı aynı olmalı' });
      return;
    }
    const tokenHash = token ? hashToken(token) : '';
    const existing = tokenHash ? readPasswordResetToken.get(tokenHash) : null;
    if (!existing || existing.expires_at <= Date.now()) {
      if (existing) deletePasswordResetToken.run(existing.token_hash);
      sendJson(response, 400, { ok: false, error: 'Bağlantı geçersiz veya süresi dolmuş' });
      return;
    }
    const salt = crypto.randomBytes(16);
    const passwordHash = await runScrypt(password, salt, clientAddress(request));
    database.exec('BEGIN IMMEDIATE');
    try {
      const current = readPasswordResetToken.get(tokenHash);
      if (!current || current.expires_at <= Date.now()) {
        database.exec('ROLLBACK');
        sendJson(response, 400, { ok: false, error: 'Bağlantı geçersiz veya süresi dolmuş' });
        return;
      }
      updateUserPassword.run(passwordHash.toString('hex'), salt.toString('hex'), current.user_id);
      deletePasswordResetTokensForUser.run(current.user_id);
      deleteUserSessions.run(current.user_id);
      database.exec('COMMIT');
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      throw error;
    }
    clearSessionCookie(response, request);
    sendJson(response, 200, { ok: true, message: 'Şifren güncellendi. Yeni şifrenle giriş yapabilirsin.' });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'API bulunamadı' });
}

const { createPackPasswordGuard, installPasswordAttemptCap } = require('./lib/pack-password');
installPasswordAttemptCap(database);
const packPassword = createPackPasswordGuard(database);

async function confirmPassword(userId, password, request) {
  const now = Date.now();
  const locked = packPassword.readLock(userId, now);
  if (locked) return { ok: false, ...locked };
  const clientIp = clientAddress(request);
  const supplied = typeof password === 'string' ? password : '';
  let matches = false;
  if (supplied.length < 8 || supplied.length > 128) {
    await consumePasswordWork(supplied, clientIp);
  } else {
    const stored = database.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').get(userId);
    if (!stored?.password_salt || !stored?.password_hash) {
      await consumePasswordWork(supplied, clientIp);
    } else {
      const candidateHash = await runScrypt(supplied, Buffer.from(stored.password_salt, 'hex'), clientIp);
      const expectedHash = Buffer.from(stored.password_hash, 'hex');
      matches = candidateHash.length === expectedHash.length && crypto.timingSafeEqual(candidateHash, expectedHash);
    }
  }
  if (matches) return packPassword.recordSuccess(userId, Date.now());
  const failure = packPassword.recordFailure(userId, Date.now());
  return { ok: false, ...failure };
}

async function requireFreshFactor(request, response, user, body) {
  const check = await confirmPassword(user.id, body?.password, request);
  if (check?.ok !== true) {
    sendJson(response, check?.locked ? 429 : 403, { ok: false, error: check?.error || 'Şifre hatalı' });
    return false;
  }
  try {
    verifyFactor(database, user, body?.code, totpKey);
    return true;
  } catch (error) {
    if (response.headersSent) return false;
    const status = Number(error.status) || 403;
    sendJson(response, status, { ok: false, error: status === 500 ? 'Sunucu isteği tamamlayamadı' : error.message });
    return false;
  }
}

const onlineLockTrigger = String(process.env.ONLINE_LOCK_TRIGGER || '').trim() === '1';
const handleRankHttp = require('./lib/rank-routes').createHandler({
  database,
  appSecret,
  totpKey,
  sendJson,
  readJsonBody,
  requireSameOrigin,
  requireSession,
  requireRank,
  requestBodyLimit,
  clientAddress,
  confirmPassword
});
const handleOnlineRequest = createOnlineApi({
  database,
  requireSession,
  requireSameOrigin,
  readJsonBody,
  sendJson,
  userRole,
  triggerEnabled: onlineLockTrigger,
  confirmPassword,
  clientAddress,
  audit(entry) {
    writeAudit(database, entry);
  }
});

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const pathname = requestUrl.pathname;
    if (request.method === 'GET' && pathname === '/healthz') {
      sendHealth(response, request);
      return;
    }
    if (shouldRedirectToHttps(request)) {
      redirectToHttps(request, response, requestUrl);
      return;
    }
    if (process.env.NODE_ENV === 'production' && isHttps(request)) {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if (request.method === 'GET' && pathname === '/api/data') {
      sendJson(response, 200, legacyData);
      return;
    }
    if (pathname.startsWith('/api/auth/')) {
      await handleAuthRequest(request, response, pathname);
      return;
    }
    if (await handleOnlineRequest(request, response, pathname, requestUrl)) return;
    if (await handleRankHttp(request, response, pathname)) return;
    if (pathname === '/api/packages' && request.method === 'GET') {
      const packages = database.prepare("SELECT * FROM packages WHERE published = 1 AND approval_status = 'approved' ORDER BY created_at DESC").all();
      sendJson(response, 200, {
        packages: packages.map(row => {
          const item = packageFromRow(row);
          delete item.submittedBy;
          delete item.submitterName;
          return item;
        })
      });
      return;
    }
    if (pathname === '/api/admin/users') {
      const user = requireAdmin(request, response);
      if (!user) return;
      if (request.method === 'GET') {
        const users = database.prepare(`
          SELECT users.id, users.email, users.username, users.verified, users.role,
            users.banned, users.isBanned, users.banReason, users.banNote, users.banType,
            users.bannedUntil, users.deviceId, users.isDeviceBanned, users.created_at,
            user_roles.role AS rank
          FROM users
          LEFT JOIN user_roles ON user_roles.user_id = users.id
          ORDER BY users.created_at DESC
        `).all();
        recordViewPii(database, user, users.map(account => account.id), clientAddress(request));
        sendJson(response, 200, {
          users: users.map(account => {
            const ban = publicBanState(account);
            const ranked = { ...account, rank: account.rank || 'player' };
            const role = userRole(ranked);
            const rank = userRank(ranked);
            return {
              id: asUserId(account.id),
              email: account.email,
              username: account.username,
              verified: Boolean(account.verified),
              role,
              rank,
              isAdmin: rank === 'admin',
              isModerator: rank === 'moderator',
              isSupport: rank === 'support',
              isModder: role === 'modder',
              deviceId: account.deviceId || null,
              createdAt: account.created_at,
              ...ban
            };
          })
        });
        return;
      }
      response.writeHead(405, { Allow: 'GET' });
      response.end('Method not allowed');
      return;
    }
    if (pathname.startsWith('/api/admin/users/')) {
      const actionMatch = pathname.match(/^\/api\/admin\/users\/(\d+)(?:\/(ban|unban|promote))?\/?$/);
      const actionName = actionMatch ? (actionMatch[2] || '') : '';
      const user = actionName === 'promote'
        ? requireRank(request, response, 'admin')
        : requireRank(request, response, 'moderator');
      if (!user) return;
      const targetId = actionMatch ? Number(actionMatch[1]) : 0;
      const action = actionMatch ? (actionMatch[2] || '') : '';
      if (!targetId) {
        sendJson(response, 400, { ok: false, error: 'Kullanıcı kimliği geçersiz' });
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' });
        response.end('Method not allowed');
        return;
      }
      if (!requireSameOrigin(request, response)) return;
      const body = await readJsonBody(request, response, requestBodyLimit(pathname, user));
      if (body === null) return;
      const target = database.prepare('SELECT id, email, role, deviceId, banned, isBanned FROM users WHERE id = ?').get(targetId);
      if (!target) {
        sendJson(response, 404, { ok: false, error: 'Kullanıcı bulunamadı' });
        return;
      }
      const targetAccount = { id: asUserId(target.id), email: target.email, role: target.role, rank: rankOf(database, target.id) };
      const peerAdminBan = user.rank === 'admin' && targetAccount.rank === 'admin' && user.id !== targetAccount.id;
      if (action === 'promote') {
        try {
          const { assignRole } = require('./lib/ranks');
          const result = assignRole(database, user, targetAccount, 'moderator', clientAddress(request));
          sendJson(response, 200, { ok: true, role: result.role });
        } catch (error) {
          sendJson(response, error.status || 500, { ok: false, error: error.status ? error.message : 'Sunucu isteği tamamlayamadı' });
        }
        return;
      }
      try {
        if (peerAdminBan) {
          if (!(await requireFreshFactor(request, response, user, body))) return;
        } else {
          assertOutranks(user, targetAccount, user.rank === 'moderator' && (targetAccount.rank === 'admin' || targetAccount.rank === 'moderator')
            ? 'Moderatör, moderatör veya yöneticiyi banlayamaz'
            : 'Yalnızca alt rütbelere işlem yapılabilir');
        }
      } catch (error) {
        sendJson(response, error.status || 403, {
          ok: false,
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.setupPath ? { setupPath: error.setupPath } : {})
        });
        return;
      }
      const shouldUnban = action === 'unban' || body.banned === false;
      const shouldBan = action === 'ban' || body.banned === true;
      if (!shouldBan && !shouldUnban) {
        sendJson(response, 400, { ok: false, error: 'Ban veya unban isteği geçersiz' });
        return;
      }
      if (shouldBan && accountIsBanned(target)) {
        sendJson(response, 409, { ok: false, error: 'Bu kullanıcı zaten banlı' });
        return;
      }
      if (shouldUnban) {
        database.exec('BEGIN IMMEDIATE');
        try {
          clearUserBan.run(targetId);
          writeAudit(database, {
            actorId: user.id,
            targetId,
            action: 'unban',
            oldValue: { banned: true },
            newValue: { banned: false },
            ip: clientAddress(request)
          });
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        sendJson(response, 200, { ok: true, banned: false, isBanned: false });
        return;
      }
      const duration = typeof body.duration === 'string' ? body.duration : (body.banType === 'TEMPORARY' ? body.duration : 'PERMANENT');
      if (!Object.hasOwn(BAN_DURATIONS, duration)) {
        sendJson(response, 400, { ok: false, error: 'Ban süresi geçersiz' });
        return;
      }
      const banReason = typeof body.banReason === 'string' ? body.banReason.trim() : (typeof body.reason === 'string' ? body.reason.trim() : '');
      const banNote = typeof body.banNote === 'string' ? body.banNote.trim() : (typeof body.note === 'string' ? body.note.trim() : '');
      if (!banReason || banReason.length > 500) {
        sendJson(response, 400, { ok: false, error: 'Ban sebebi 1-500 karakter olmalı' });
        return;
      }
      if (banNote.length > 1000) {
        sendJson(response, 400, { ok: false, error: 'Admin notu en fazla 1000 karakter olabilir' });
        return;
      }
      const deviceBan = body.deviceBan === true || body.isDeviceBanned === true;
      const banType = duration === 'PERMANENT' ? 'PERMANENT' : 'TEMPORARY';
      const bannedUntil = banType === 'TEMPORARY' ? new Date(Date.now() + BAN_DURATIONS[duration]).toISOString() : null;
      const now = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`
          UPDATE users SET banned = 1, isBanned = 1, banReason = ?, banNote = ?, banType = ?,
            bannedAt = ?, bannedUntil = ?, isDeviceBanned = ? WHERE id = ?
        `).run(banReason, banNote || null, banType, now, bannedUntil, deviceBan ? 1 : 0, targetId);
        database.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(targetId);
        require('./lib/online-market').cancelListingsForUser(database, targetId, now);
        writeAudit(database, {
          actorId: user.id,
          targetId,
          action: 'ban',
          oldValue: { banned: Boolean(accountIsBanned(target)) },
          newValue: { banned: true, banType, duration, reason: banReason, until: bannedUntil, deviceBan, reauth: peerAdminBan === true },
          ip: clientAddress(request)
        });
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      sendJson(response, 200, {
        ok: true,
        banned: true,
        isBanned: true,
        banType,
        banReason,
        banNote: banNote || null,
        bannedUntil,
        isDeviceBanned: deviceBan
      });
      return;
    }
    if (pathname === '/api/admin/packages') {
      const user = requireStaff(request, response);
      if (!user) return;
      const actorIsAdmin = userRole(user) === 'admin';
      if (request.method === 'GET') {
        const packages = actorIsAdmin
          ? database.prepare(`${packageListSql} ORDER BY packages.created_at DESC`).all()
          : database.prepare(`${packageListSql} WHERE packages.submitted_by = ? ORDER BY packages.created_at DESC`).all(user.id);
        sendJson(response, 200, { packages: packages.map(packageFromRow) });
        return;
      }
      if (request.method === 'POST') {
        if (!requireSameOrigin(request, response)) return;
        const body = await readJsonBody(request, response, requestBodyLimit(pathname, user));
        if (body === null) {
          if (!response.headersSent) sendJson(response, 400, { ok: false, error: 'Paket verisi geçersiz' });
          return;
        }
        let item;
        try {
          item = validatePackage(body);
        } catch (error) {
          sendJson(response, error.status || 400, { ok: false, error: error.message });
          return;
        }
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        const draft = !actorIsAdmin;
        database.prepare(`
          INSERT INTO packages (id, title, description, price, currency, stock, config, published, approval_status, submitted_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, item.title, item.description, item.price, item.currency, item.stock, JSON.stringify(item.config),
          draft ? 0 : (item.published ? 1 : 0), draft ? 'draft' : 'approved', user.id, now, now
        );
        sendJson(response, 201, {
          ok: true,
          draft,
          package: { id, ...item, published: draft ? false : item.published, approvalStatus: draft ? 'draft' : 'approved', roster: null }
        });
        return;
      }
      response.writeHead(405, { Allow: 'GET, POST' });
      response.end('Method not allowed');
      return;
    }
    const packageReview = pathname.match(/^\/api\/admin\/packages\/([^/]+)\/(approve|reject|submit)$/);
    if (packageReview) {
      const action = packageReview[2];
      const user = action === 'submit' ? requireStaff(request, response) : requireAdmin(request, response);
      if (!user) return;
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' });
        response.end('Method not allowed');
        return;
      }
      if (!requireSameOrigin(request, response)) return;
      const packageId = decodeURIComponent(packageReview[1]);
      const existing = database.prepare(`${packageListSql} WHERE packages.id = ?`).get(packageId);
      if (!existing) {
        sendJson(response, 404, { ok: false, error: 'Paket bulunamadı' });
        return;
      }
      if (action === 'submit') {
        if (userRole(user) === 'admin' || asUserId(existing.submitted_by) !== user.id || existing.approval_status !== 'draft') {
          sendJson(response, 403, { ok: false, error: 'Yalnızca kendi taslağını onaya gönderebilirsin' });
          return;
        }
        let roster;
        try {
          roster = normalizeRoster(parseRoster(existing.roster), JSON.parse(existing.config).totalTeams, true);
        } catch (error) {
          sendJson(response, error.status || 400, { ok: false, error: error.message || 'Takım ve oyuncu bilgisi eksik' });
          return;
        }
        const now = new Date().toISOString();
        database.prepare("UPDATE packages SET roster = ?, approval_status = 'pending', published = 0, updated_at = ? WHERE id = ?").run(JSON.stringify(roster), now, packageId);
        sendJson(response, 200, { ok: true, package: packageFromRow({ ...existing, roster: JSON.stringify(roster), approval_status: 'pending', published: 0 }) });
        return;
      }
      const now = new Date().toISOString();
      if (action === 'approve') {
        database.prepare("UPDATE packages SET approval_status = 'approved', published = 1, reviewed_at = ?, updated_at = ? WHERE id = ?").run(now, now, packageId);
        sendJson(response, 200, { ok: true, package: packageFromRow({ ...existing, approval_status: 'approved', published: 1, reviewed_at: now }) });
        return;
      }
      database.prepare("UPDATE packages SET approval_status = 'rejected', published = 0, reviewed_at = ?, updated_at = ? WHERE id = ?").run(now, now, packageId);
      sendJson(response, 200, { ok: true, package: packageFromRow({ ...existing, approval_status: 'rejected', published: 0, reviewed_at: now }) });
      return;
    }
    if (pathname.startsWith('/api/admin/packages/')) {
      const user = requireStaff(request, response);
      if (!user) return;
      const actorIsAdmin = userRole(user) === 'admin';
      const id = decodeURIComponent(pathname.slice('/api/admin/packages/'.length));
      const existing = database.prepare('SELECT * FROM packages WHERE id = ?').get(id);
      if (!existing) {
        sendJson(response, 404, { ok: false, error: 'Paket bulunamadı' });
        return;
      }
      if (!actorIsAdmin && (asUserId(existing.submitted_by) !== user.id || existing.approval_status !== 'draft')) {
        sendJson(response, 403, { ok: false, error: 'Yalnızca kendi taslağını düzenleyebilirsin' });
        return;
      }
      if (request.method === 'PUT') {
        if (!requireSameOrigin(request, response)) return;
        const body = await readJsonBody(request, response, requestBodyLimit(pathname, user));
        if (body === null) {
          if (!response.headersSent) sendJson(response, 400, { ok: false, error: 'Paket verisi geçersiz' });
          return;
        }
        let item;
        let rosterJson = existing.roster || null;
        try {
          item = validatePackage(body);
          if (!actorIsAdmin && body.roster !== undefined) {
            rosterJson = JSON.stringify(normalizeRoster(body.roster, item.config.totalTeams, false));
          }
        } catch (error) {
          sendJson(response, error.status || 400, { ok: false, error: error.message });
          return;
        }
        const now = new Date().toISOString();
        if (!actorIsAdmin) {
          database.prepare('UPDATE packages SET title = ?, description = ?, price = ?, currency = ?, stock = ?, config = ?, roster = ?, published = 0, approval_status = ?, updated_at = ? WHERE id = ?').run(
            item.title, item.description, item.price, item.currency, item.stock, JSON.stringify(item.config), rosterJson, 'draft', now, id
          );
        } else {
          database.prepare('UPDATE packages SET title = ?, description = ?, price = ?, currency = ?, stock = ?, config = ?, published = ?, updated_at = ? WHERE id = ?').run(
            item.title, item.description, item.price, item.currency, item.stock, JSON.stringify(item.config), item.published ? 1 : 0, now, id
          );
          if (Number(existing.price) !== Number(item.price) || existing.currency !== item.currency) {
            writeAudit(database, {
              actorId: user.id,
              action: 'economy_change',
              oldValue: { packageId: id, price: existing.price, currency: existing.currency },
              newValue: { packageId: id, price: item.price, currency: item.currency },
              ip: clientAddress(request)
            });
          }
        }
        const saved = database.prepare(`${packageListSql} WHERE packages.id = ?`).get(id);
        sendJson(response, 200, { ok: true, package: packageFromRow(saved) });
        return;
      }
      if (request.method === 'DELETE') {
        if (!requireSameOrigin(request, response)) return;
        database.prepare('DELETE FROM packages WHERE id = ?').run(id);
        sendJson(response, 200, { ok: true });
        return;
      }
      response.writeHead(405, { Allow: 'PUT, DELETE' });
      response.end('Method not allowed');
      return;
    }
    if (pathname === '/api/admin/shop' && request.method === 'GET') {
      const user = requireAdmin(request, response);
      if (!user) return;
      const orders = database.prepare(`
        SELECT orders.*, users.username, users.email
        FROM orders JOIN users ON users.id = orders.user_id
        ORDER BY orders.created_at DESC
        LIMIT 100
      `).all();
      const settings = shopSettings();
      sendJson(response, 200, {
        settings: {
          accountName: settings.account_name || '',
          iban: settings.iban ? formatIban(settings.iban) : '',
          bankName: settings.bank_name || '',
          note: settings.note || ''
        },
        orders: orders.map(orderFromRow)
      });
      return;
    }
    if (pathname === '/api/admin/shop/iban' && request.method === 'POST') {
      const user = requireAdmin(request, response);
      if (!user) return;
      if (!requireSameOrigin(request, response)) return;
      const body = await readJsonBody(request, response, requestBodyLimit(pathname, user));
      if (!body) return;
      const accountName = typeof body.accountName === 'string' ? body.accountName.trim() : '';
      const iban = normalizeIban(body.iban);
      const bankName = typeof body.bankName === 'string' ? body.bankName.trim() : '';
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      if (accountName.length < 3 || accountName.length > 80) {
        sendJson(response, 400, { ok: false, error: 'Hesap adı 3-80 karakter olmalı' });
        return;
      }
      if (!validTrIban(iban)) {
        sendJson(response, 400, { ok: false, error: 'Geçerli bir Türkiye IBAN\'ı gir' });
        return;
      }
      if (bankName.length > 60 || note.length > 240) {
        sendJson(response, 400, { ok: false, error: 'Banka adı veya not çok uzun' });
        return;
      }
      const previousShop = database.prepare('SELECT account_name, iban, bank_name FROM shop_settings WHERE id = 1').get();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`
          INSERT INTO shop_settings (id, account_name, iban, bank_name, note)
          VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET account_name = excluded.account_name, iban = excluded.iban, bank_name = excluded.bank_name, note = excluded.note
        `).run(accountName, iban, bankName, note);
        writeAudit(database, {
          actorId: user.id,
          action: 'economy_change',
          oldValue: previousShop ? { accountName: previousShop.account_name, bankName: previousShop.bank_name } : null,
          newValue: { accountName, bankName, ibanChanged: true },
          ip: clientAddress(request)
        });
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
      sendJson(response, 200, { ok: true, payment: paymentInstructions() });
      return;
    }
    const orderReview = pathname.match(/^\/api\/admin\/shop\/orders\/(\d+)\/(confirm|reject)$/);
    if (orderReview) {
      const user = requireAdmin(request, response);
      if (!user) return;
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' });
        response.end('Method not allowed');
        return;
      }
      if (!requireSameOrigin(request, response)) return;
      const orderId = Number(orderReview[1]);
      const order = database.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!order || order.status !== 'pending') {
        sendJson(response, 404, { ok: false, error: 'Bekleyen sipariş bulunamadı' });
        return;
      }
      const now = new Date().toISOString();
      database.exec('BEGIN');
      try {
        if (orderReview[2] === 'confirm') {
          database.prepare("UPDATE orders SET status = 'confirmed', reviewed_at = ? WHERE id = ? AND status = 'pending'").run(now, orderId);
        } else {
          database.prepare("UPDATE orders SET status = 'rejected', reviewed_at = ? WHERE id = ? AND status = 'pending'").run(now, orderId);
          if (order.package_id) database.prepare('UPDATE packages SET stock = stock + 1, updated_at = ? WHERE id = ?').run(now, order.package_id);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      sendJson(response, 200, { ok: true, status: orderReview[2] === 'confirm' ? 'confirmed' : 'rejected' });
      return;
    }
    if (pathname === '/api/shop/orders' && request.method === 'GET') {
      const user = requireSession(request, response);
      if (!user) return;
      const orders = database.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(user.id).map(row => {
        const order = orderFromRow(row);
        delete order.email;
        delete order.username;
        return order;
      });
      sendJson(response, 200, {
        orders,
        payment: orders.some(order => order.status === 'pending') ? paymentInstructions() : null,
        user: publicUser(user)
      });
      return;
    }
    if (pathname === '/api/shop/orders' && request.method === 'POST') {
      const user = requireSession(request, response);
      if (!user) return;
      if (!requireSameOrigin(request, response)) return;
      const body = await readJsonBody(request, response, requestBodyLimit(pathname, user));
      if (!body) return;
      const payment = paymentInstructions();
      if (!payment) {
        sendJson(response, 409, { ok: false, error: 'Ödeme hesabı henüz bağlanmamış' });
        return;
      }
      const packageId = typeof body.packageId === 'string' ? body.packageId : '';
      const pendingCount = database.prepare("SELECT COUNT(*) AS total FROM orders WHERE user_id = ? AND status = 'pending'").get(user.id);
      if (Number(pendingCount?.total || 0) >= 3) {
        sendJson(response, 409, { ok: false, error: 'Önce bekleyen bir siparişi tamamla veya iptal et' });
        return;
      }
      let created = null;
      database.exec('BEGIN IMMEDIATE');
      try {
        const item = database.prepare("SELECT * FROM packages WHERE id = ? AND published = 1 AND approval_status = 'approved'").get(packageId);
        if (!item || item.stock < 1) {
          database.exec('ROLLBACK');
          sendJson(response, 409, { ok: false, error: 'Paket stokta yok' });
          return;
        }
        const now = new Date().toISOString();
        const reserved = database.prepare('UPDATE packages SET stock = stock - 1, updated_at = ? WHERE id = ? AND stock > 0').run(now, packageId);
        if (!reserved.changes) {
          database.exec('ROLLBACK');
          sendJson(response, 409, { ok: false, error: 'Paket stokta yok' });
          return;
        }
        let referenceCode = '';
        let inserted = false;
        for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
          referenceCode = createOrderReference();
          try {
            const result = database.prepare(`
              INSERT INTO orders (user_id, package_id, package_title, price, currency, reference_code, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
            `).run(user.id, item.id, item.title, item.price, item.currency, referenceCode, now);
            created = { id: Number(result.lastInsertRowid), referenceCode };
            inserted = true;
          } catch (error) {
            if (!String(error.code || error.message).includes('CONSTRAINT')) throw error;
          }
        }
        if (!inserted) throw new Error('Referans kodu üretilemedi');
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        if (response.headersSent) return;
        throw error;
      }
      const order = database.prepare('SELECT * FROM orders WHERE id = ?').get(created.id);
      sendJson(response, 201, { ok: true, order: orderFromRow(order), payment });
      return;
    }
    const orderCancel = pathname.match(/^\/api\/shop\/orders\/(\d+)\/cancel$/);
    if (orderCancel && request.method === 'POST') {
      const user = requireSession(request, response);
      if (!user) return;
      if (!requireSameOrigin(request, response)) return;
      const order = database.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(Number(orderCancel[1]), user.id);
      if (!order || order.status !== 'pending') {
        sendJson(response, 404, { ok: false, error: 'İptal edilecek bekleyen sipariş yok' });
        return;
      }
      const now = new Date().toISOString();
      database.exec('BEGIN');
      try {
        database.prepare("UPDATE orders SET status = 'rejected', reviewed_at = ? WHERE id = ? AND status = 'pending'").run(now, order.id);
        if (order.package_id) database.prepare('UPDATE packages SET stock = stock + 1, updated_at = ? WHERE id = ?').run(now, order.package_id);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    if (pathname === '/api/account/profile') {
      const user = requireSession(request, response);
      if (!user) return;
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' });
        response.end('Method not allowed');
        return;
      }
      if (!requireSameOrigin(request, response)) return;
      const body = await readJsonBody(request, response, requestBodyLimit(pathname, user));
      if (!body) return;
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (!validUsername(username)) {
        sendJson(response, 400, { ok: false, error: 'Kullanıcı adı 2-32 karakter olmalı' });
        return;
      }
      let avatarData = user.avatar_data || null;
      if (body.removeAvatar === true) avatarData = null;
      else if (Object.hasOwn(body, 'avatarData')) {
        avatarData = validAvatarData(body.avatarData);
        if (avatarData === undefined) {
          sendJson(response, 400, { ok: false, error: 'Profil fotoğrafı geçersiz veya 512 KB sınırını aşıyor' });
          return;
        }
      }
      database.prepare('UPDATE users SET username = ?, avatar_data = ? WHERE id = ?').run(username, avatarData, user.id);
      sendJson(response, 200, { ok: true, user: publicUser({ id: user.id, email: user.email, username, avatar_data: avatarData, role: user.role }) });
      return;
    }
    if (pathname === '/api/account/data') {
      if (request.method === 'GET') {
        const user = requireSession(request, response, true);
        if (!user) return;
        const row = readUserData.get(user.id);
        sendJson(response, 200, row ? normalizeData(JSON.parse(row.payload)) : defaultData);
        return;
      }
      if (request.method === 'POST') {
        if (!requireSameOrigin(request, response)) return;
        const { user, ban } = inspectSession(request);
        const data = await readJsonBody(request, response, requestBodyLimit(pathname, user));
        if (!data) return;
        if (!user && ban) {
          sendBanBlocked(response, ban);
          return;
        }
        if (user && ban) {
          sendBanBlocked(response, ban);
          return;
        }
        if (!user) {
          sendJson(response, 401, { ok: false, error: 'Oturum açmanız gerekiyor' });
          return;
        }
        const normalized = normalizeData(data);
        writeUserData.run(user.id, JSON.stringify(normalized), new Date().toISOString());
        sendJson(response, 200, { ok: true });
        return;
      }
      response.writeHead(405, { Allow: 'GET, POST' });
      response.end('Method not allowed');
      return;
    }
    if (pathname === '/api/data' && request.method === 'POST') {
      sendJson(response, 403, { ok: false, error: 'Ortak turnuva ve takımlar salt okunurdur' });
      return;
    }
    if (request.method === 'GET' && pathname === '/locale.js') {
      sendStaticFile(response, path.join(root, 'locale.js'), {
        'Content-Type': 'application/javascript; charset=utf-8'
      }, root);
      return;
    }
    if (request.method === 'GET' && (pathname === '/favicon.ico' || pathname === '/apple-touch-icon.png' || pathname === '/apple-touch-icon-precomposed.png')) {
      sendStaticFile(response, path.join(root, 'brand', 'verse.png'), {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff'
      }, path.join(root, 'brand'));
      return;
    }
    if (request.method === 'GET' && /^\/brand\/(verse|faroe|sweden|norway|denmark)\.png$/.test(pathname)) {
      sendStaticFile(response, path.join(root, 'brand', path.basename(pathname)), {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff'
      }, path.join(root, 'brand'));
      return;
    }
    if (request.method === 'GET' && legalPages[pathname]) {
      response.writeHead(200, {
        ...securityHeaders(),
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'"
      });
      response.end(legalPages[pathname]);
      return;
    }
    if (request.method === 'GET' && (pathname === '/' || pathname === '/tour-maker.html')) {
      sendStaticFile(response, path.join(root, 'tour-maker.html'), {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'"
      }, root);
      return;
    }
    sendNotFound(response);
  } catch (error) {
    try {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      const badRequest = error?.code === 'ERR_INVALID_URL' || error instanceof URIError;
      const status = Number(error.status);
      if (!badRequest && (status === 429 || status === 503)) {
        console.error('İstek başarısız:', error.code || error.name);
        sendJson(response, status, {
          ok: false,
          error: error.message || 'Sunucu şu an meşgul. Kısa bir süre sonra tekrar deneyin.'
        });
        return;
      }
      if (!badRequest) console.error('İstek başarısız:', error.code || error.name);
      sendJson(response, badRequest ? 400 : 500, {
        ok: false,
        error: badRequest ? 'Geçersiz istek' : 'Sunucu isteği tamamlayamadı'
      });
    } catch {
      response.destroy();
    }
  }
});

try {
  catchUpDailySim(database, new Date(), '');
} catch (error) {
  console.error('Online kilit başarısız:', error.code || error.name);
}
scheduleOnlineLock(database, '');

server.listen(port, host, () => {
  console.log(`Omni.verse hazır: http://${host}:${port}`);
  console.log('Hesap verileri hesap bazında, mevcut turnuva ve takımlar ortak salt okunur kayıt olarak tutuluyor.');
  if (!mailConfigured()) console.log('E-posta doğrulaması şu an kapalı.');
  if (!isLoopbackName(host) && !trustProxyEnabled()) {
    console.warn('Uyarı: HOST döngü adresi değil ve TRUST_PROXY=1 değil. Secure oturum çerezleri HTTPS gerektirir.');
  }
});
