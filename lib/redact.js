function collectSecrets(env) {
  return [
    env && env.TURSO_AUTH_TOKEN,
    env && env.TURSO_DATABASE_URL,
    env && env.SMTP_PASS,
    env && env.BREVO_API_KEY,
    env && env.SESSION_SECRET,
    env && env.TOTP_ENC_KEY,
    env && env.BACKUP_PASSPHRASE
  ].map(value => String(value || '')).filter(value => value.length >= 6);
}

function redact(value, env = process.env) {
  let text = String(value ?? '');
  for (const secret of collectSecrets(env)) {
    text = text.split(secret).join('[redacted]');
  }
  text = text.replace(/\blibsql:\/\/\S+/gi, '[redacted-db-url]');
  text = text.replace(/\bhttps?:\/\/[^\s'"]*turso\.io\S*/gi, '[redacted-db-url]');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [redacted]');
  text = text.replace(/([?&](?:authToken|token|jwt|password)=)[^&\s]+/gi, '$1[redacted]');
  return text;
}

module.exports = { redact, collectSecrets };
