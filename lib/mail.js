const nodemailer = require('nodemailer');

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const MAIL_TIMEOUT_MS = 10000;

function trimmed(env, name) {
  return String(env?.[name] ?? '').trim();
}

function brevoSelected(env) {
  return trimmed(env, 'BREVO_API_KEY') !== '';
}

function unavailable() {
  return Object.assign(
    new Error('E-posta gönderimi şu an kullanılamıyor. Daha sonra tekrar dene.'),
    { status: 503 }
  );
}

function safeLabel(error) {
  const raw = error && (typeof error.code === 'string' ? error.code : error.name);
  const label = String(raw || 'Error');
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(label)) return 'Error';
  return label;
}

function loggedFailure(error) {
  console.error('Doğrulama e-postası gönderilemedi:', safeLabel(error));
  return Object.assign(
    new Error('E-posta gönderilemedi. SMTP ayarlarını kontrol edin.'),
    { status: 503 }
  );
}

function smtpSettings(env) {
  const hostName = trimmed(env, 'SMTP_HOST');
  const portNumber = Number(trimmed(env, 'SMTP_PORT'));
  const user = trimmed(env, 'SMTP_USER');
  const password = env?.SMTP_PASS;
  const from = trimmed(env, 'EMAIL_FROM');
  if (!hostName || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535 || !user || !password || !from) {
    return null;
  }
  return { hostName, portNumber, user, password, from };
}

function mailConfigured(env = process.env) {
  if (brevoSelected(env)) return trimmed(env, 'MAIL_FROM_EMAIL') !== '';
  return smtpSettings(env) !== null;
}

async function deliverBrevo(message, env, fetchImpl) {
  const apiKey = trimmed(env, 'BREVO_API_KEY');
  const response = await fetchImpl(BREVO_ENDPOINT, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      sender: {
        email: trimmed(env, 'MAIL_FROM_EMAIL'),
        name: trimmed(env, 'MAIL_FROM_NAME') || 'Omni'
      },
      to: [{ email: message.to }],
      subject: message.subject,
      htmlContent: message.html,
      textContent: message.text
    })
  });
  if (response && typeof response.text === 'function') {
    try { await response.text(); } catch {}
  }
  if (!response || response.ok !== true) {
    const failure = new Error('Brevo request failed');
    failure.code = 'EBREVO';
    throw failure;
  }
}

async function deliverSmtp(message, env, createTransport) {
  const settings = smtpSettings(env);
  const transporter = createTransport({
    host: settings.hostName,
    port: settings.portNumber,
    secure: settings.portNumber === 465,
    auth: { user: settings.user, pass: settings.password }
  });
  await transporter.sendMail({
    from: settings.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html
  });
}

async function sendMail(message, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || globalThis.fetch;
  const createTransport = options.createTransport || (settings => nodemailer.createTransport(settings));
  if (brevoSelected(env)) {
    if (!trimmed(env, 'MAIL_FROM_EMAIL')) throw unavailable();
    try {
      await deliverBrevo(message, env, fetchImpl);
    } catch (error) {
      throw loggedFailure(error);
    }
    return;
  }
  if (!smtpSettings(env)) throw unavailable();
  try {
    await deliverSmtp(message, env, createTransport);
  } catch (error) {
    throw loggedFailure(error);
  }
}

module.exports = {
  BREVO_ENDPOINT,
  MAIL_TIMEOUT_MS,
  mailConfigured,
  sendMail
};
