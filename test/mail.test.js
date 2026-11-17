const test = require('node:test');
const assert = require('node:assert/strict');
const { BREVO_ENDPOINT, MAIL_TIMEOUT_MS, mailConfigured, sendMail } = require('../lib/mail');

const message = {
  to: 'user@example.com',
  subject: 'Turnuva hesabı e-posta doğrulama kodu',
  text: 'E-posta doğrulama kodunuz: 123456\nKod 10 dakika geçerlidir.',
  html: '<p>E-posta doğrulama kodunuz:</p><p>123456</p>'
};

function brevoEnv(extra = {}) {
  return {
    BREVO_API_KEY: 'xkeysib-test-key-do-not-log',
    MAIL_FROM_EMAIL: 'noreply@example.com',
    ...extra
  };
}

test('Brevo transport posts the transactional payload over HTTPS', async () => {
  const seen = [];
  const timeouts = [];
  let smtpCalled = false;
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = milliseconds => {
    timeouts.push(milliseconds);
    return originalTimeout.call(AbortSignal, milliseconds);
  };
  try {
    await sendMail(message, {
      env: brevoEnv(),
      fetch: async (url, init) => {
        seen.push({ url, init });
        return { ok: true, status: 201, text: async () => '{"messageId":"abc"}' };
      },
      createTransport() {
        smtpCalled = true;
        throw new Error('SMTP should not be used');
      }
    });
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
  assert.equal(smtpCalled, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, BREVO_ENDPOINT);
  assert.equal(seen[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers['api-key'], 'xkeysib-test-key-do-not-log');
  assert.equal(seen[0].init.headers['content-type'], 'application/json');
  assert.equal(JSON.stringify(seen[0].init.headers).includes('authorization'), false);
  assert.ok(seen[0].init.signal instanceof AbortSignal);
  assert.deepEqual(timeouts, [MAIL_TIMEOUT_MS]);
  assert.equal(MAIL_TIMEOUT_MS, 10000);
  const body = JSON.parse(seen[0].init.body);
  assert.deepEqual(body, {
    sender: { email: 'noreply@example.com', name: 'Omni' },
    to: [{ email: 'user@example.com' }],
    subject: message.subject,
    htmlContent: message.html,
    textContent: message.text
  });
  assert.equal(seen[0].init.body.includes('xkeysib-test-key-do-not-log'), false);
  assert.equal(seen[0].url.includes('xkeysib-test-key-do-not-log'), false);
});

test('MAIL_FROM_NAME is sent as the Brevo sender name', async () => {
  let body;
  await sendMail(message, {
    env: brevoEnv({ MAIL_FROM_NAME: 'Stüdyo' }),
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 201, text: async () => '' };
    }
  });
  assert.equal(body.sender.name, 'Stüdyo');
  assert.equal(body.sender.email, 'noreply@example.com');
});

test('Brevo non-2xx responses fail like an SMTP send failure', async () => {
  const apiKey = 'xkeysib-failure-key';
  const logs = [];
  const original = console.error;
  console.error = (...parts) => {
    logs.push(parts.map(part => String(part)).join(' '));
  };
  try {
    await assert.rejects(
      () => sendMail(message, {
        env: {
          BREVO_API_KEY: apiKey,
          MAIL_FROM_EMAIL: 'noreply@example.com',
          MAIL_FROM_NAME: 'Omni',
          SMTP_HOST: '127.0.0.1',
          SMTP_PORT: '587',
          SMTP_USER: 'mailer',
          SMTP_PASS: 'smtp-secret',
          EMAIL_FROM: 'from@example.com'
        },
        fetch: async (_url, init) => ({
          ok: false,
          status: 401,
          text: async () => `unauthorized ${apiKey} ${JSON.stringify(init.headers)}`
        }),
        createTransport() {
          throw new Error('SMTP fallback must not run when the Brevo key is set');
        }
      }),
      error => {
        assert.equal(error.status, 503);
        assert.equal(error.message, 'E-posta gönderilemedi. SMTP ayarlarını kontrol edin.');
        assert.equal(error.message.includes(apiKey), false);
        assert.equal(Object.prototype.hasOwnProperty.call(error, 'headers'), false);
        return true;
      }
    );
  } finally {
    console.error = original;
  }
  const logged = logs.join('\n');
  assert.match(logged, /EBREVO/);
  assert.equal(logged.includes(apiKey), false);
  assert.equal(logged.includes('api-key'), false);
  assert.equal(logged.includes('unauthorized'), false);
  assert.equal(logged.includes('smtp-secret'), false);
});

test('SMTP is used when the Brevo key is absent', async () => {
  const transports = [];
  const sent = [];
  await sendMail(message, {
    env: {
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '2525',
      SMTP_USER: 'mailer',
      SMTP_PASS: 'smtp-secret',
      EMAIL_FROM: 'from@example.com'
    },
    fetch: async () => {
      throw new Error('fetch should not be called');
    },
    createTransport(options) {
      transports.push(options);
      return {
        sendMail: async payload => {
          sent.push(payload);
        }
      };
    }
  });
  assert.deepEqual(transports, [{
    host: '127.0.0.1',
    port: 2525,
    secure: false,
    auth: { user: 'mailer', pass: 'smtp-secret' }
  }]);
  assert.deepEqual(sent, [{
    from: 'from@example.com',
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html
  }]);
});

test('a blank Brevo key keeps the SMTP path, including implicit TLS on port 465', async () => {
  let fetchCalled = false;
  const transports = [];
  await sendMail(message, {
    env: {
      BREVO_API_KEY: '   ',
      MAIL_FROM_EMAIL: 'noreply@example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_USER: 'mailer',
      SMTP_PASS: 'smtp-secret',
      EMAIL_FROM: 'from@example.com'
    },
    fetch: async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called');
    },
    createTransport(options) {
      transports.push(options);
      return { sendMail: async () => {} };
    }
  });
  assert.equal(fetchCalled, false);
  assert.equal(transports[0].secure, true);
  assert.equal(transports[0].port, 465);
});

test('mail is unavailable until Brevo or SMTP settings are complete', async () => {
  await assert.rejects(
    () => sendMail(message, {
      env: { BREVO_API_KEY: 'xkeysib-test-key-do-not-log' },
      fetch: async () => {
        throw new Error('fetch should not be called');
      }
    }),
    error => {
      assert.equal(error.status, 503);
      assert.equal(error.message, 'E-posta gönderimi şu an kullanılamıyor. Daha sonra tekrar dene.');
      return true;
    }
  );
  assert.equal(mailConfigured({ BREVO_API_KEY: 'key', MAIL_FROM_EMAIL: 'a@b.c' }), true);
  assert.equal(mailConfigured({ BREVO_API_KEY: 'key' }), false);
  assert.equal(mailConfigured({
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '587',
    SMTP_USER: 'mailer',
    SMTP_PASS: 'secret',
    EMAIL_FROM: 'from@example.com'
  }), true);
  assert.equal(mailConfigured({}), false);
});
