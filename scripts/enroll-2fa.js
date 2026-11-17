const assert = require('node:assert/strict');
const { totpCode } = require('../lib/ranks');

async function enrollTwoFactor(httpCall, port, cookie, password) {
  const setup = await httpCall({
    port,
    method: 'POST',
    pathname: '/api/account/2fa/setup',
    headers: { Cookie: cookie },
    body: JSON.stringify({ password })
  });
  assert.equal(setup.status, 200, setup.text);
  const code = totpCode(setup.json.secret);
  assert.match(code, /^\d{6}$/);
  const confirm = await httpCall({
    port,
    method: 'POST',
    pathname: '/api/account/2fa/confirm',
    headers: { Cookie: cookie },
    body: JSON.stringify({ password, code })
  });
  assert.equal(confirm.status, 200, confirm.text);
  return setup.json;
}

module.exports = { enrollTwoFactor };
