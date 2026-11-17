const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const root = require('path').join(__dirname, '..');
const smtpPort = 2526;
const failures = [];
const mails = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
  else console.log('OK', message);
}

function request(port, method, pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { ...extraHeaders };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.end(data);
    else req.end();
  });
}

function startSmtp() {
  return new Promise(resolve => {
    const server = net.createServer(socket => {
      let buffer = '';
      let mode = 'cmd';
      let data = '';
      socket.write('220 localhost ESMTP\r\n');
      socket.on('data', chunk => {
        buffer += chunk.toString('binary');
        if (mode === 'data') {
          data += buffer;
          buffer = '';
          const end = data.indexOf('\r\n.\r\n');
          if (end >= 0) {
            mails.push(data.slice(0, end).replace(/\r\n/g, '\n'));
            data = '';
            mode = 'cmd';
            socket.write('250 OK\r\n');
          }
          return;
        }
        let index;
        while ((index = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (upper.startsWith('AUTH LOGIN')) {
            mode = 'auth-user';
            socket.write('334 VXNlcm5hbWU6\r\n');
          } else if (mode === 'auth-user') {
            mode = 'auth-pass';
            socket.write('334 UGFzc3dvcmQ6\r\n');
          } else if (mode === 'auth-pass' || upper.startsWith('AUTH')) {
            mode = 'cmd';
            socket.write('235 OK\r\n');
          } else if (upper === 'DATA') {
            mode = 'data';
            data = '';
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (upper === 'QUIT') {
            socket.write('221 Bye\r\n');
            socket.end();
          } else socket.write('250 OK\r\n');
        }
      });
    });
    server.listen(smtpPort, '127.0.0.1', () => resolve(server));
  });
}

function startApp(port, databaseFile, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.ADMIN_EMAIL;
  env.PORT = String(port);
  env.HOST = '127.0.0.1';
  env.DATABASE_FILE = databaseFile;
  env.DATA_FILE = databaseFile + '.json';
  env.SMTP_HOST = '127.0.0.1';
  env.SMTP_PORT = String(smtpPort);
  env.SMTP_USER = 'test';
  env.SMTP_PASS = 'test';
  env.EMAIL_FROM = 'test@localhost';
  delete env.BREVO_API_KEY;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const timer = setTimeout(() => reject(new Error('Sunucu açılmadı\n' + log)), 8000);
    const onData = chunk => {
      log += chunk.toString();
      if (log.includes('Omni.verse hazır')) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.output = () => log;
    child.on('exit', code => {
      clearTimeout(timer);
      if (code) reject(new Error('Sunucu kapandı ' + code + '\n' + log));
    });
  });
}

function stopApp(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 2000);
  });
}

function register(port, email, password, username) {
  return request(port, 'POST', '/api/auth/register', { email, username, password, confirmation: password });
}

async function waitForMails(count) {
  const start = Date.now();
  while (mails.length < count) {
    if (Date.now() - start > 5000) throw new Error('E-posta gelmedi: ' + mails.length);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

function codeFrom(message) {
  const match = String(message || '').match(/\b(\d{6})\b/);
  if (!match) throw new Error('Kod yok');
  return match[1];
}

function ageSends(databaseFile, email) {
  const db = new DatabaseSync(databaseFile);
  db.prepare('UPDATE verification_sends SET sent_at = ? WHERE email = ?').run(Date.now() - 120000, email);
  db.close();
}

function pendingAttempts(databaseFile, email) {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db.prepare('SELECT attempts FROM pending_registrations WHERE email = ? ORDER BY id').all(email)
      .map(row => Number(row.attempts));
  } finally {
    db.close();
  }
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  assert(major > 22 || (major === 22 && minor >= 5), 'Node >= 22.5 (' + process.version + ')');
  const dbFile = '/tmp/auth-registration-check.db';
  const raceDb = '/tmp/auth-registration-race.db';
  for (const file of [dbFile, raceDb]) {
    for (const suffix of ['', '-wal', '-shm', '.json']) fs.rmSync(file + suffix, { force: true });
  }
  const smtp = await startSmtp();
  const port = 3461;
  let app = await startApp(port, dbFile);

  const first = await register(port, 'victim@x.com', 'PasswordA1', 'VictimA');
  assert(first.status === 201, 'kurban kaydı 201: ' + first.status);
  await waitForMails(1);
  const codeA = codeFrom(mails[0]);

  const rushed = await register(port, 'victim@x.com', 'PasswordB1', 'Attacker');
  assert(rushed.status === 429 && /bir dakika/.test(rushed.text), '60 sn içindeki ikinci kayıt 429: ' + rushed.status + ' ' + rushed.text);
  const resendBody = '{"ok":true,"message":"E-posta adresi kayıtlıysa yeni doğrulama kodu gönderildi"}';
  const resendMailAt = mails.length;
  const resend = await request(port, 'POST', '/api/auth/resend', { email: 'victim@x.com', password: 'PasswordA1' });
  const resendWrong = await request(port, 'POST', '/api/auth/resend', { email: 'victim@x.com', password: 'NopeNope1' });
  const resendMissing = await request(port, 'POST', '/api/auth/resend', { email: 'yok@x.com', password: 'PasswordA1' });
  assert(resend.status === 200 && resend.text === resendBody, 'kota doluyken doğru şifre de 200: ' + resend.status + ' ' + resend.text);
  assert(resendWrong.text === resendBody && resendMissing.text === resendBody, 'kod yenileme yanıtı her durumda aynı');
  assert(mails.length === resendMailAt, 'kota doluyken ek mektup gitmedi');
  const stillA = await request(port, 'POST', '/api/auth/login', { email: 'victim@x.com', password: 'PasswordA1' });
  assert(stillA.status === 403, 'erken ikinci kayıt şifreyi değiştirmedi: ' + stillA.status);

  ageSends(dbFile, 'victim@x.com');
  const attack = await register(port, 'victim@x.com', 'PasswordB1', 'Attacker');
  assert(attack.status === 201, 'bekleme sonrası ayrı bekleyen kayıt 201: ' + attack.status + ' ' + attack.text);
  await waitForMails(2);
  const codeB = codeFrom(mails[1]);
  assert(codeA !== codeB, 'iki kayıt iki ayrı kod üretti');

  const loginAttacker = await request(port, 'POST', '/api/auth/login', { email: 'victim@x.com', password: 'PasswordB1' });
  assert(loginAttacker.status === 401, 'saldırganın şifresi henüz geçerli değil: ' + loginAttacker.status);
  const takeover = await request(port, 'POST', '/api/auth/verify', { email: 'victim@x.com', code: codeB, password: 'PasswordA1' });
  assert(takeover.status === 400 && /şifre/.test(takeover.text), 'son kod + kurban şifresi hesabı açmadı: ' + takeover.status + ' ' + takeover.text);
  const stillUnverified = await request(port, 'POST', '/api/auth/login', { email: 'victim@x.com', password: 'PasswordA1' });
  assert(stillUnverified.status === 403, 'ele geçirme denemesinden sonra hesap hâlâ doğrulanmamış');

  const activated = await request(port, 'POST', '/api/auth/verify', { email: 'victim@x.com', code: codeA, password: 'PasswordA1' });
  assert(activated.status === 200 && activated.json?.user?.username === 'VictimA', 'kurban kendi kodu ve şifresiyle açıldı: ' + activated.text);
  const loginA = await request(port, 'POST', '/api/auth/login', { email: 'victim@x.com', password: 'PasswordA1' });
  const loginB = await request(port, 'POST', '/api/auth/login', { email: 'victim@x.com', password: 'PasswordB1' });
  assert(loginA.status === 200 && loginB.status === 401, 'yalnız kurbanın şifresi geçerli: ' + loginA.status + '/' + loginB.status);

  const overwrite = await register(port, 'victim@x.com', 'PasswordC1', 'VictimC');
  assert(overwrite.status === 409, 'doğrulanmış hesap 409: ' + overwrite.status + ' ' + overwrite.text);

  const stale = await register(port, 'stale@x.com', 'PasswordA1', 'StaleA');
  assert(stale.status === 201, 'süresi dolacak kayıt 201');
  await waitForMails(3);
  await stopApp(app);
  const aged = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const db = new DatabaseSync(dbFile);
  db.prepare('UPDATE users SET created_at = ?').run(aged);
  db.prepare('UPDATE pending_registrations SET created_at = ?').run(aged);
  db.close();
  app = await startApp(port, dbFile);
  const probe = new DatabaseSync(dbFile, { readOnly: true });
  const users = probe.prepare('SELECT email, verified FROM users ORDER BY email').all();
  const pending = probe.prepare('SELECT email FROM pending_registrations').all();
  probe.close();
  assert(users.some(row => row.email === 'victim@x.com' && row.verified === 1), 'eski doğrulanmış hesap duruyor: ' + JSON.stringify(users));
  assert(!users.some(row => row.email === 'stale@x.com'), '24 saatten eski doğrulanmamış hesap silindi: ' + JSON.stringify(users));
  assert(!pending.some(row => row.email === 'stale@x.com'), 'eski bekleyen kayıt silindi: ' + JSON.stringify(pending));
  await stopApp(app);

  const racePort = 3462;
  const raceApp = await startApp(racePort, raceDb);
  const pair = await Promise.all([
    register(racePort, 'race@x.com', 'PasswordA1', 'RaceA'),
    register(racePort, 'race@x.com', 'PasswordB1', 'RaceB')
  ]);
  const statuses = pair.map(item => item.status).sort((left, right) => left - right);
  assert(!pair.some(item => item.status === 500), 'eşzamanlı kayıt 500 döndürmedi: ' + pair.map(item => item.status + ' ' + item.text).join(' | '));
  assert(statuses[0] === 201 && statuses[1] === 409, 'eşzamanlı kayıt 201 ve 409: ' + statuses.join(','));

  const seeded = new DatabaseSync(raceDb);
  const sentAt = Date.now() - 120000;
  const insertSend = seeded.prepare('INSERT INTO verification_sends (email, sent_at) VALUES (?, ?)');
  for (let count = 0; count < 5; count += 1) insertSend.run('bomb@x.com', sentAt);
  seeded.close();
  const capped = await register(racePort, 'bomb@x.com', 'PasswordA1', 'BombA');
  assert(capped.status === 429 && /çok fazla doğrulama/.test(capped.text), 'saatlik e-posta sınırı 429: ' + capped.status + ' ' + capped.text);
  await stopApp(raceApp);

  const variantDb = '/tmp/auth-registration-variant.db';
  const variantPort = 3465;
  for (const suffix of ['', '-wal', '-shm', '.json']) fs.rmSync(variantDb + suffix, { force: true });
  const variantApp = await startApp(variantPort, variantDb);
  const variantBefore = mails.length;
  const canon = await register(variantPort, 'canon@x.com', 'PasswordA1', 'CanonA');
  assert(canon.status === 201, 'kanonik kayıt 201: ' + canon.status);
  await waitForMails(variantBefore + 1);
  const canonCode = codeFrom(mails[variantBefore]);
  const variantForms = [
    ['büyük harf', 'Canon@X.com'],
    ['boşluk', '  canon@x.com \t'],
    ['U+200B', 'can\u200bon@x.com'],
    ['U+2060', 'can\u2060on@x.com']
  ];
  for (const [label, email] of variantForms) {
    const before = mails.length;
    const variant = await register(variantPort, email, 'PasswordB1', 'VarA');
    assert(variant.status === 429 && /bir dakika/.test(variant.text), label + ' aynı limite takıldı: ' + variant.status + ' ' + variant.text);
    assert(mails.length === before, label + ' yeni mektup göndermedi');
  }
  const anonHeaders = { 'X-Forwarded-For': '203.0.113.99' };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wrong = await request(variantPort, 'POST', '/api/auth/verify', {
      email: 'canon@x.com', code: '000000', password: 'NopeNope1'
    }, anonHeaders);
    assert(wrong.status === 400 && /şifre/.test(wrong.text), 'anonim yanlış deneme genel hata: ' + wrong.status);
  }
  const attemptsAfterAnon = pendingAttempts(variantDb, 'canon@x.com');
  assert(attemptsAfterAnon.length === 1 && attemptsAfterAnon[0] === 0, 'anonim denemeler kaydı kilitlemedi: ' + JSON.stringify(attemptsAfterAnon));
  const variantVerify = await request(variantPort, 'POST', '/api/auth/verify', {
    email: 'ca\u200bnon@x.com', code: canonCode, password: 'PasswordA1'
  }, anonHeaders);
  assert(variantVerify.status === 200 && variantVerify.json?.user?.email === 'canon@x.com', 'görünmez karakterli adres aynı kaydı doğruladı: ' + variantVerify.text);
  await stopApp(variantApp);

  const moreDb = '/tmp/auth-registration-variant-more.db';
  const morePort = 3466;
  for (const suffix of ['', '-wal', '-shm', '.json']) fs.rmSync(moreDb + suffix, { force: true });
  const moreApp = await startApp(morePort, moreDb);
  const moreBefore = mails.length;
  const moreReg = await register(morePort, 'more@x.com', 'PasswordA1', 'MoreA');
  assert(moreReg.status === 201, 'ikinci varyant kaydı 201');
  await waitForMails(moreBefore + 1);
  const moreForms = [
    ['U+00AD', 'mo\u00adre@x.com'],
    ['U+200C', 'mo\u200cre@x.com'],
    ['U+200D', 'mo\u200dre@x.com'],
    ['NFKC', '\uFF4D\uFF4F\uFF52\uFF45@x.com']
  ];
  for (const [label, email] of moreForms) {
    const before = mails.length;
    const variant = await register(morePort, email, 'PasswordB1', 'VarB');
    assert(variant.status === 429 && /bir dakika/.test(variant.text), label + ' aynı limite takıldı: ' + variant.status + ' ' + variant.text);
    assert(mails.length === before, label + ' yeni mektup göndermedi');
  }
  await stopApp(moreApp);

  const plainDb = '/tmp/auth-registration-plain-ip.db';
  const plainPort = 3467;
  for (const suffix of ['', '-wal', '-shm', '.json']) fs.rmSync(plainDb + suffix, { force: true });
  const plainApp = await startApp(plainPort, plainDb);
  for (let index = 1; index <= 5; index += 1) {
    const created = await request(plainPort, 'POST', '/api/auth/register', {
      email: `plain${index}@x.com`, username: 'Plain' + index, password: 'PasswordA1', confirmation: 'PasswordA1'
    }, { 'X-Forwarded-For': `198.51.100.${index}` });
    assert(created.status === 201, 'TRUST_PROXY kapalıyken XFF yok sayıldı ' + index + ': ' + created.status + ' ' + created.text);
  }
  const plainBlocked = await request(plainPort, 'POST', '/api/auth/register', {
    email: 'plain6@x.com', username: 'Plain6', password: 'PasswordA1', confirmation: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.250' });
  assert(plainBlocked.status === 429 && /Çok fazla deneme/.test(plainBlocked.text), 'farklı XFF soket limitini aşamaz: ' + plainBlocked.status + ' ' + plainBlocked.text);
  await stopApp(plainApp);

  const sameDb = '/tmp/auth-registration-same-ip.db';
  const samePort = 3468;
  for (const suffix of ['', '-wal', '-shm', '.json']) fs.rmSync(sameDb + suffix, { force: true });
  const sameApp = await startApp(samePort, sameDb);
  const sameBefore = mails.length;
  const raced = await Promise.all([
    register(samePort, 'same@x.com', 'PasswordA1', 'SameA'),
    register(samePort, 'sa\u200bme@x.com', 'PasswordB1', 'SameB')
  ]);
  const raceStatuses = raced.map(item => item.status).sort((left, right) => left - right);
  assert(!raced.some(item => item.status === 500), 'aynı IP varyant yarışı 500 değil: ' + raced.map(item => item.status).join(','));
  assert(raceStatuses[0] === 201 && raceStatuses[1] === 409, 'aynı IP kanonik yarış 201/409: ' + raceStatuses.join(','));
  await waitForMails(sameBefore + 1);
  assert(mails.length === sameBefore + 1, 'eşzamanlı varyant tek mektup gönderdi: ' + (mails.length - sameBefore));
  await stopApp(sameApp);

  const proxyDb = '/tmp/auth-registration-proxy.db';
  const proxyPort = 3469;
  for (const suffix of ['', '-wal', '-shm', '.json']) fs.rmSync(proxyDb + suffix, { force: true });
  const proxyApp = await startApp(proxyPort, proxyDb, { TRUST_PROXY: '1' });
  for (let index = 1; index <= 5; index += 1) {
    const created = await request(proxyPort, 'POST', '/api/auth/register', {
      email: `xff${index}@x.com`, username: 'Xff' + index, password: 'PasswordA1', confirmation: 'PasswordA1'
    }, { 'X-Forwarded-For': `198.51.100.1, 203.0.113.7` });
    assert(created.status === 201, 'sağdaki XFF ile kayıt ' + index + ': ' + created.status + ' ' + created.text);
  }
  const rightBlocked = await request(proxyPort, 'POST', '/api/auth/register', {
    email: 'xff-right@x.com', username: 'XffR', password: 'PasswordA1', confirmation: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.7' });
  assert(rightBlocked.status === 429 && /Çok fazla deneme/.test(rightBlocked.text), 'sağdaki adresin limiti doldu: ' + rightBlocked.status + ' ' + rightBlocked.text);
  const leftFresh = await request(proxyPort, 'POST', '/api/auth/register', {
    email: 'xff-left@x.com', username: 'XffL', password: 'PasswordA1', confirmation: 'PasswordA1'
  }, { 'X-Forwarded-For': '198.51.100.1' });
  assert(leftFresh.status === 201, 'soldaki sahte adres ayrı limit değil: ' + leftFresh.status + ' ' + leftFresh.text);

  const safeBefore = mails.length;
  const safeReg = await request(proxyPort, 'POST', '/api/auth/register', {
    email: 'safe@x.com', username: 'SafeA', password: 'PasswordA1', confirmation: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.80' });
  assert(safeReg.status === 201, 'başka IP kurban kaydı 201');
  await waitForMails(safeBefore + 1);
  const safeCode = codeFrom(mails[safeBefore]);
  const attackerForwarded = { 'X-Forwarded-For': '198.51.100.9, 203.0.113.71' };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await request(proxyPort, 'POST', '/api/auth/verify', {
      email: 'safe@x.com', code: '000000', password: 'NopeNope1'
    }, attackerForwarded);
  }
  const concurrentAnon = await Promise.all([1, 2, 3, 4].map(() => request(proxyPort, 'POST', '/api/auth/verify', {
    email: 'safe@x.com', code: '111111', password: 'NopeNope1'
  }, attackerForwarded)));
  assert(concurrentAnon.every(item => item.status === 400 || item.status === 429) && concurrentAnon.some(item => item.status === 400), 'aynı IP eşzamanlı anonim denemeler kaydı açmadı: ' + concurrentAnon.map(item => item.status).join(','));
  const safeAttempts = pendingAttempts(proxyDb, 'safe@x.com');
  assert(safeAttempts.length === 1 && safeAttempts[0] === 0, 'başka IP kurbanın denemesini artırmadı: ' + JSON.stringify(safeAttempts));
  const safeVerify = await request(proxyPort, 'POST', '/api/auth/verify', {
    email: 'Safe@X.com', code: safeCode, password: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.80' });
  assert(safeVerify.status === 200, 'başka IP kurban kendi şifresiyle doğruladı: ' + safeVerify.status + ' ' + safeVerify.text);

  const sharedBefore = mails.length;
  const sharedReg = await request(proxyPort, 'POST', '/api/auth/register', {
    email: 'shared@x.com', username: 'SharedA', password: 'PasswordA1', confirmation: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.70' });
  assert(sharedReg.status === 201, 'paylaşılan IP kaydı 201');
  await waitForMails(sharedBefore + 1);
  const sharedCode = codeFrom(mails[sharedBefore]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await request(proxyPort, 'POST', '/api/auth/verify', {
      email: 'shared@x.com', code: '000000', password: 'NopeNope1'
    }, { 'X-Forwarded-For': '198.51.100.9, 203.0.113.70' });
  }
  const sharedAttempts = pendingAttempts(proxyDb, 'shared@x.com');
  assert(sharedAttempts[0] === 0, 'paylaşılan IP anonim denemesi kaydı kilitlemedi: ' + JSON.stringify(sharedAttempts));
  const sharedVerify = await request(proxyPort, 'POST', '/api/auth/verify', {
    email: 'shared@x.com', code: sharedCode, password: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.70' });
  assert(sharedVerify.status === 200, 'aynı IP kurban şifreyi bilince doğruladı: ' + sharedVerify.status + ' ' + sharedVerify.text);

  const multiBefore = mails.length;
  const multiA = await request(proxyPort, 'POST', '/api/auth/register', {
    email: 'multi@x.com', username: 'MultiA', password: 'PasswordA1', confirmation: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.51' });
  assert(multiA.status === 201, 'çoklu bekleyen ilk kayıt 201: ' + multiA.text);
  await waitForMails(multiBefore + 1);
  const codeMultiA = codeFrom(mails[multiBefore]);
  ageSends(proxyDb, 'multi@x.com');
  const multiB1 = await request(proxyPort, 'POST', '/api/auth/register', {
    email: 'multi@x.com', username: 'MultiB', password: 'PasswordB1', confirmation: 'PasswordB1'
  }, { 'X-Forwarded-For': '203.0.113.51' });
  assert(multiB1.status === 201, 'aynı şifreli ikinci bekleyen 201: ' + multiB1.text);
  await waitForMails(multiBefore + 2);
  ageSends(proxyDb, 'multi@x.com');
  const multiB2 = await request(proxyPort, 'POST', '/api/auth/register', {
    email: 'multi@x.com', username: 'MultiB2', password: 'PasswordB1', confirmation: 'PasswordB1'
  }, { 'X-Forwarded-For': '203.0.113.51' });
  assert(multiB2.status === 201, 'aynı şifreli üçüncü bekleyen 201: ' + multiB2.text);
  await waitForMails(multiBefore + 3);
  const codeMultiB = codeFrom(mails[multiBefore + 1]);
  const usedCodes = new Set([codeMultiA, codeMultiB, codeFrom(mails[multiBefore + 2])]);
  let wrongMulti = '000000';
  while (usedCodes.has(wrongMulti)) wrongMulti = String(Number(wrongMulti) + 1).padStart(6, '0');
  const firstWrong = await request(proxyPort, 'POST', '/api/auth/verify', {
    email: 'multi@x.com', code: wrongMulti, password: 'PasswordB1'
  }, { 'X-Forwarded-For': '203.0.113.51' });
  assert(firstWrong.status === 400, 'şifreyi bilen yanlış kod 400');
  const afterOne = pendingAttempts(proxyDb, 'multi@x.com');
  assert(afterOne.join(',') === '0,1,1', 'yanlış kod aynı şifreli tüm kayıtlara yazıldı: ' + JSON.stringify(afterOne));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await request(proxyPort, 'POST', '/api/auth/verify', {
      email: 'multi@x.com', code: wrongMulti, password: 'PasswordB1'
    }, { 'X-Forwarded-For': '203.0.113.52' });
  }
  const burned = await request(proxyPort, 'POST', '/api/auth/verify', {
    email: 'multi@x.com', code: codeMultiB, password: 'PasswordB1'
  }, { 'X-Forwarded-For': '203.0.113.53' });
  assert(burned.status === 400, 'beş yanlıştan sonra doğru kod da açılmadı: ' + burned.status + ' ' + burned.text);
  const victimStill = await request(proxyPort, 'POST', '/api/auth/verify', {
    email: 'multi@x.com', code: codeMultiA, password: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.54' });
  assert(victimStill.status === 200 && victimStill.json?.user?.username === 'MultiA', 'diğer şifrenin denemesi kurbanı kilitlemedi: ' + victimStill.text);
  await stopApp(proxyApp);

  const shapeDb = '/tmp/auth-registration-shape.db';
  const shapePort = 3471;
  for (const suffix of ['', '-wal', '-shm', '.json']) fs.rmSync(shapeDb + suffix, { force: true });
  const shapeApp = await startApp(shapePort, shapeDb);
  const shapeBefore = mails.length;
  const shapeReg = await register(shapePort, 'inbox@x.com', 'PasswordA1', 'InboxA');
  assert(shapeReg.status === 201, 'Şekil kaydı 201');
  await waitForMails(shapeBefore + 1);
  for (const [label, email] of [
    ['U+034F', 'in\u034fbox@x.com'],
    ['U+3164', 'in\u3164box@x.com'],
    ['Türkçe İ', '\u0130nbox@x.com'],
    ['U+2800', 'in\u2800box@x.com']
  ]) {
    const before = mails.length;
    const variant = await register(shapePort, email, 'PasswordB1', 'ShapeB');
    assert(variant.status === 429 && /bir dakika/.test(variant.text), label + ' aynı adrese indi: ' + variant.status + ' ' + variant.text);
    assert(mails.length === before, label + ' mektup göndermedi');
  }
  const absentStarted = Date.now();
  const absent = await request(shapePort, 'POST', '/api/auth/verify', { email: 'yok@x.com', code: '000000', password: 'PasswordA1' });
  const absentMs = Date.now() - absentStarted;
  const presentStarted = Date.now();
  const present = await request(shapePort, 'POST', '/api/auth/verify', { email: 'inbox@x.com', code: '000000', password: 'NopeNope1' });
  const presentMs = Date.now() - presentStarted;
  assert(absent.status === 400 && present.status === 400, 'olmayan ve olan hesap aynı genel hatayı verir');
  assert(absentMs > presentMs * 0.3 && presentMs > absentMs * 0.3, 'olmayan hesap da scrypt süresi harcıyor: ' + absentMs + 'ms / ' + presentMs + 'ms');
  async function elapsed(task) {
    const started = Date.now();
    const result = await task();
    return { ms: Date.now() - started, result };
  }
  const knownResend = await elapsed(() => request(shapePort, 'POST', '/api/auth/resend', { email: 'inbox@x.com', password: 'NopeNope1' }));
  const unknownResend = await elapsed(() => request(shapePort, 'POST', '/api/auth/resend', { email: 'ghost@x.com', password: 'NopeNope1' }));
  const knownLogin = await elapsed(() => request(shapePort, 'POST', '/api/auth/login', { email: 'inbox@x.com', password: 'NopeNope1' }));
  const unknownLogin = await elapsed(() => request(shapePort, 'POST', '/api/auth/login', { email: 'ghost@x.com', password: 'NopeNope1' }));
  assert(knownResend.result.status === 200 && unknownResend.result.status === 200, 'zamanlama istekleri 200: ' + knownResend.result.status + '/' + unknownResend.result.status);
  assert(unknownResend.ms > knownResend.ms * 0.4 && knownResend.ms > unknownResend.ms * 0.4, 'kod yenileme süresi hesabı ele vermiyor: ' + knownResend.ms + 'ms / ' + unknownResend.ms + 'ms');
  assert(unknownLogin.ms > knownLogin.ms * 0.4 && knownLogin.ms > unknownLogin.ms * 0.4, 'giriş süresi hesabı ele vermiyor: ' + knownLogin.ms + 'ms / ' + unknownLogin.ms + 'ms');
  await stopApp(shapeApp);

  const floodDb = '/tmp/auth-registration-flood.db';
  const floodPort = 3472;
  for (const suffix of ['', '-wal', '-shm', '.json']) fs.rmSync(floodDb + suffix, { force: true });
  const floodApp = await startApp(floodPort, floodDb, { TRUST_PROXY: ' 1 ' });
  for (let index = 1; index <= 5; index += 1) {
    const created = await request(floodPort, 'POST', '/api/auth/register', {
      email: `pad${index}@x.com`, username: 'Pad' + index, password: 'PasswordA1', confirmation: 'PasswordA1'
    }, { 'X-Forwarded-For': `198.51.100.2, 203.0.113.77` });
    assert(created.status === 201, 'TRUST_PROXY=" 1 " sağdaki adres ' + index + ': ' + created.status);
  }
  const padBlocked = await request(floodPort, 'POST', '/api/auth/register', {
    email: 'pad-block@x.com', username: 'PadB', password: 'PasswordA1', confirmation: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.77' });
  assert(padBlocked.status === 429 && /Çok fazla deneme/.test(padBlocked.text), 'boşluklu TRUST_PROXY açık sayıldı: ' + padBlocked.status + ' ' + padBlocked.text);
  const floodBefore = mails.length;
  const floodReg = await request(floodPort, 'POST', '/api/auth/register', {
    email: 'flood@x.com', username: 'FloodA', password: 'PasswordA1', confirmation: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.40' });
  assert(floodReg.status === 201, 'yarış kaydı 201: ' + floodReg.text);
  await waitForMails(floodBefore + 1);
  ageSends(floodDb, 'flood@x.com');
  const ownerResend = request(floodPort, 'POST', '/api/auth/resend', {
    email: 'flood@x.com', password: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.41' });
  const wrongFlood = await Promise.all([
    ownerResend,
    ...Array.from({ length: 40 }, (_, index) => request(floodPort, 'POST', '/api/auth/resend', {
      email: 'flood@x.com', password: 'NopeNope1'
    }, { 'X-Forwarded-For': `198.51.100.${index + 1}` }))
  ]);
  await waitForMails(floodBefore + 2);
  assert(wrongFlood[0].status === 200, 'yanlış şifre seli sahibin mektubunu kesmedi: ' + wrongFlood[0].status + ' ' + wrongFlood[0].text);
  assert(mails.length - (floodBefore + 1) === 1, 'yanlış şifre seli tek mektup bıraktı: ' + (mails.length - floodBefore - 1));
  ageSends(floodDb, 'flood@x.com');
  const floodStarted = Date.now();
  const flood = await Promise.all(Array.from({ length: 60 }, (_, index) => request(floodPort, 'POST', '/api/auth/resend', {
    email: 'flood@x.com', password: 'PasswordA1'
  }, { 'X-Forwarded-For': `203.0.113.${100 + index}` })));
  await waitForMails(floodBefore + 3);
  const floodMails = mails.length - (floodBefore + 2);
  assert(floodMails === 1, '60 eşzamanlı kod yenileme en fazla 1 mektup: ' + floodMails);
  assert(flood.some(item => item.status === 200), 'yarışta bir istek kodu gönderdi');
  assert(Date.now() - floodStarted < 8000, 'yarış gönderimi takılı kalmadı');
  const cpuBefore = mails.length;
  const cpuReg = await request(floodPort, 'POST', '/api/auth/register', {
    email: 'cpu@x.com', username: 'CpuA', password: 'PasswordA1', confirmation: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.90' });
  assert(cpuReg.status === 201, 'cpu kaydı 201');
  await waitForMails(cpuBefore + 1);
  const cpuCode = codeFrom(mails[cpuBefore]);
  const burstStarted = Date.now();
  const burst = await Promise.all(Array.from({ length: 40 }, () => request(floodPort, 'POST', '/api/auth/verify', {
    email: 'cpu@x.com', code: '000000', password: 'NopeNope1'
  }, { 'X-Forwarded-For': '203.0.113.91' })));
  const burstMs = Date.now() - burstStarted;
  const blockedBurst = burst.filter(item => item.status === 429).length;
  assert(blockedBurst >= 15, 'scrypt öncesi limit devrede: ' + blockedBurst + ' / ' + burstMs + 'ms');
  assert(burstMs < 2500, '40 yanlış doğrulama scrypt kuyruğunu doldurmadı: ' + burstMs + 'ms');
  const cpuVictim = await request(floodPort, 'POST', '/api/auth/verify', {
    email: 'cpu@x.com', code: cpuCode, password: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.92' });
  assert(cpuVictim.status === 200, 'başka IP kurban limit doluyken doğruladı: ' + cpuVictim.status + ' ' + cpuVictim.text);
  const stillBlocked = await request(floodPort, 'POST', '/api/auth/verify', {
    email: 'cpu@x.com', code: '000000', password: 'NopeNope1'
  }, { 'X-Forwarded-For': '203.0.113.91' });
  assert(stillBlocked.status === 429, 'aynı IP pencere bitmeden 429');
  await new Promise(resolve => setTimeout(resolve, 10500));
  const afterWindow = await request(floodPort, 'POST', '/api/auth/verify', {
    email: 'cpu2@x.com', code: '000000', password: 'NopeNope1'
  }, { 'X-Forwarded-For': '203.0.113.91' });
  assert(afterWindow.status === 400, 'kısa pencere dolunca aynı IP yine deneyebildi: ' + afterWindow.status + ' ' + afterWindow.text);
  await stopApp(floodApp);

  const migrateDb = '/tmp/auth-registration-migrate.db';
  const migratePort = 3473;
  for (const suffix of ['', '-wal', '-shm', '.json']) fs.rmSync(migrateDb + suffix, { force: true });
  let migrateApp = await startApp(migratePort, migrateDb);
  const migrateMailAt = mails.length;
  const keeperReg = await register(migratePort, 'clean@x.com', 'PasswordA1', 'KeeperA');
  const otherReg = await register(migratePort, 'other@x.com', 'PasswordB1', 'OtherB');
  assert(keeperReg.status === 201 && otherReg.status === 201, 'göç hesapları açıldı');
  await waitForMails(migrateMailAt + 2);
  const keeperCode = codeFrom(mails[migrateMailAt]);
  const otherCode = codeFrom(mails[migrateMailAt + 1]);
  const keeperVerified = await request(migratePort, 'POST', '/api/auth/verify', { email: 'clean@x.com', code: keeperCode, password: 'PasswordA1' });
  const otherVerified = await request(migratePort, 'POST', '/api/auth/verify', { email: 'other@x.com', code: otherCode, password: 'PasswordB1' });
  assert(keeperVerified.status === 200 && otherVerified.status === 200, 'göç hesapları doğrulandı');
  await stopApp(migrateApp);
  const beforeMigrate = new DatabaseSync(migrateDb);
  const beforeRows = beforeMigrate.prepare('SELECT id, email, password_hash FROM users ORDER BY id').all();
  beforeMigrate.prepare('UPDATE users SET email = ? WHERE email = ?').run('clea\u200bn@x.com', 'other@x.com');
  beforeMigrate.close();
  migrateApp = await startApp(migratePort, migrateDb);
  assert(/çakışma/.test(migrateApp.output()), 'çakışma uyarısı yazıldı: ' + migrateApp.output());
  const afterMigrate = new DatabaseSync(migrateDb, { readOnly: true });
  const afterRows = afterMigrate.prepare('SELECT id, email, password_hash FROM users ORDER BY id').all();
  afterMigrate.close();
  assert(afterRows.length === 2, 'iki hesap da duruyor');
  assert(afterRows.every((row, index) => row.password_hash === beforeRows[index].password_hash), 'parola hashleri değişmedi');
  const keeperLogin = await request(migratePort, 'POST', '/api/auth/login', { email: 'clean@x.com', password: 'PasswordA1' });
  const wrongOwner = await request(migratePort, 'POST', '/api/auth/login', { email: 'clean@x.com', password: 'PasswordB1' });
  const flagged = afterRows.find(row => row.email !== 'clean@x.com');
  const flaggedLogin = await request(migratePort, 'POST', '/api/auth/login', { email: flagged.email, password: 'PasswordB1' });
  assert(keeperLogin.status === 200 && keeperLogin.json?.user?.username === 'KeeperA', 'eski doğrulanmış hesap kanonik adreste: ' + keeperLogin.text);
  assert(wrongOwner.status === 401, 'diğer parolası kanonik adrese yazılmadı');
  assert(flagged && flaggedLogin.status === 200 && flaggedLogin.json?.user?.username === 'OtherB', 'çakışan hesap kendi adresiyle girebildi: ' + flagged?.email + ' ' + flaggedLogin.text);
  await stopApp(migrateApp);

  const suffixDb = '/tmp/auth-registration-suffix.db';
  const suffixPort = 3474;
  for (const suffix of ['', '-wal', '-shm', '.json']) fs.rmSync(suffixDb + suffix, { force: true });
  let suffixApp = await startApp(suffixPort, suffixDb);
  const suffixAccounts = [
    ['dup@x.com', 'PasswordA1', 'DupA'],
    ['temp@x.com', 'PasswordC1', 'TempC'],
    ['dup+legacy2@x.com', 'PasswordB1', 'LegacyB']
  ];
  for (const [email, password, username] of suffixAccounts) {
    const mailAt = mails.length;
    const created = await register(suffixPort, email, password, username);
    assert(created.status === 201, 'legacy hesap açıldı ' + email + ': ' + created.status + ' ' + created.text);
    await waitForMails(mailAt + 1);
    const verified = await request(suffixPort, 'POST', '/api/auth/verify', {
      email, code: codeFrom(mails[mailAt]), password
    });
    assert(verified.status === 200, 'legacy hesap doğrulandı ' + email + ': ' + verified.status);
  }
  await stopApp(suffixApp);
  const suffixEdit = new DatabaseSync(suffixDb);
  suffixEdit.prepare('UPDATE users SET email = ? WHERE email = ?').run('du\u200bp@x.com', 'temp@x.com');
  suffixEdit.close();
  suffixApp = await startApp(suffixPort, suffixDb);
  assert(/çakışma/.test(suffixApp.output()), 'dolu legacy soneki uyarısı: ' + suffixApp.output());
  const suffixRead = new DatabaseSync(suffixDb, { readOnly: true });
  const suffixRows = suffixRead.prepare('SELECT id, email FROM users ORDER BY id').all();
  suffixRead.close();
  const moved = suffixRows.find(row => row.email.startsWith('dup+legacy') && row.email !== 'dup+legacy2@x.com');
  const keptLegacy = suffixRows.find(row => row.email === 'dup+legacy2@x.com');
  const canonicalDup = suffixRows.find(row => row.email === 'dup@x.com');
  assert(canonicalDup && keptLegacy && moved, 'üç adres de duruyor: ' + JSON.stringify(suffixRows));
  const dupLogin = await request(suffixPort, 'POST', '/api/auth/login', { email: 'dup@x.com', password: 'PasswordA1' });
  const legacyLogin = await request(suffixPort, 'POST', '/api/auth/login', { email: 'dup+legacy2@x.com', password: 'PasswordB1' });
  const movedLogin = await request(suffixPort, 'POST', '/api/auth/login', { email: moved.email, password: 'PasswordC1' });
  assert(dupLogin.status === 200 && legacyLogin.status === 200 && movedLogin.status === 200, 'çakışan legacy satırı sunucuyu düşürmedi: ' + [dupLogin.status, legacyLogin.status, movedLogin.status].join(','));
  await stopApp(suffixApp);

  const loadDb = '/tmp/auth-registration-load.db';
  const loadPort = 3475;
  for (const suffix of ['', '-wal', '-shm', '.json']) fs.rmSync(loadDb + suffix, { force: true });
  const loadApp = await startApp(loadPort, loadDb, { TRUST_PROXY: '1' });
  const loadMailAt = mails.length;
  const loadReg = await register(loadPort, 'login@x.com', 'PasswordA1', 'LoginA');
  assert(loadReg.status === 201, 'yük testi kaydı 201');
  await waitForMails(loadMailAt + 1);
  const loadVerified = await request(loadPort, 'POST', '/api/auth/verify', {
    email: 'login@x.com', code: codeFrom(mails[loadMailAt]), password: 'PasswordA1'
  });
  assert(loadVerified.status === 200, 'yük testi hesabı doğrulandı');
  const calmStarted = Date.now();
  const calm = await request(loadPort, 'POST', '/api/auth/login', { email: 'login@x.com', password: 'PasswordA1' });
  const calmMs = Date.now() - calmStarted;
  assert(calm.status === 200, 'sakin giriş oldu');
  const floodLoad = Promise.all(Array.from({ length: 400 }, (_, index) => request(loadPort, 'POST', '/api/auth/verify', {
    email: `load${index}@x.com`, code: '000000', password: 'NopeNope1'
  }, { 'X-Forwarded-For': `198.51.${Math.floor(index / 250)}.${(index % 250) + 1}` })));
  await new Promise(resolve => setTimeout(resolve, 30));
  const busyStarted = Date.now();
  const busyLogin = await request(loadPort, 'POST', '/api/auth/login', { email: 'login@x.com', password: 'PasswordA1' });
  const busyMs = Date.now() - busyStarted;
  const floodResults = await floodLoad;
  const rejected = floodResults.filter(item => item.status === 429 || item.status === 503).length;
  assert(busyLogin.status === 200 || busyLogin.status === 429, 'sel sırasında giriş bekleyip yığılmadı: ' + busyLogin.status);
  assert(busyMs < Math.max(400, calmMs * 4), 'sel girişi aç bırakmadı: sakin ' + calmMs + 'ms, sel ' + busyMs + 'ms');
  assert(rejected > 200, 'selin çoğu scrypt kuyruğuna girmeden reddedildi: ' + rejected);
  await stopApp(loadApp);

  const isolateDb = '/tmp/auth-registration-isolate.db';
  const isolatePort = 3476;
  for (const suffix of ['', '-wal', '-shm', '.json']) fs.rmSync(isolateDb + suffix, { force: true });
  const isolateApp = await startApp(isolatePort, isolateDb, { TRUST_PROXY: '1' });
  const junk = await Promise.all(Array.from({ length: 30 }, (_, index) => request(isolatePort, 'POST', '/api/auth/register', {
    email: `not an email ${index}`, username: 'Junk', password: 'PasswordA1', confirmation: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.10' })));
  assert(junk.every(item => item.status === 400 || item.status === 429), 'tek IP geçersiz e-posta başkasını ilgilendirmez: ' + junk.map(item => item.status).join(','));
  const isolateMailAt = mails.length;
  const otherRegister = await request(isolatePort, 'POST', '/api/auth/register', {
    email: 'other-ip@x.com', username: 'OtherIp', password: 'PasswordA1', confirmation: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.11' });
  assert(otherRegister.status === 201, 'başka IP kayıt oldu: ' + otherRegister.status + ' ' + otherRegister.text);
  await waitForMails(isolateMailAt + 1);
  const otherVerify = await request(isolatePort, 'POST', '/api/auth/verify', {
    email: 'other-ip@x.com', code: codeFrom(mails[isolateMailAt]), password: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.11' });
  assert(otherVerify.status === 200, 'başka IP doğruladı: ' + otherVerify.status + ' ' + otherVerify.text);
  const otherResend = await request(isolatePort, 'POST', '/api/auth/resend', {
    email: 'other-ip@x.com', password: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.11' });
  assert(otherResend.status === 200 && otherResend.text === resendBody, 'başka IP kod yeniledi: ' + otherResend.status + ' ' + otherResend.text);
  const oneIp = await Promise.all(Array.from({ length: 20 }, () => request(isolatePort, 'POST', '/api/auth/login', {
    email: `solo${Math.random()}@x.com`, password: 'PasswordA1'
  }, { 'X-Forwarded-For': '203.0.113.12' })));
  const oneIpAccepted = oneIp.filter(item => item.status !== 429).length;
  assert(oneIpAccepted <= 2, 'tek IP scrypt kuyruğunda en fazla kendi payını tutar: ' + oneIpAccepted + ' ' + oneIp.map(item => item.status).join(','));
  const legitFlood = Promise.all(Array.from({ length: 24 }, (_, index) => request(isolatePort, 'POST', '/api/auth/login', {
    email: `crowd${index}@x.com`, password: 'PasswordA1'
  }, { 'X-Forwarded-For': `203.0.113.${20 + (index % 8)}` })));
  await new Promise(resolve => setTimeout(resolve, 20));
  const legit = [];
  for (let index = 0; index < 8; index += 1) {
    legit.push(await request(isolatePort, 'POST', '/api/auth/login', {
      email: 'other-ip@x.com', password: 'PasswordA1'
    }, { 'X-Forwarded-For': '203.0.113.200' }));
  }
  const legitOk = legit.filter(item => item.status === 200).length;
  await legitFlood;
  assert(legitOk >= 6, 'çok IP selinde başka IP girişleri sürdü: ' + legitOk + ' ' + legit.map(item => item.status).join(','));
  await stopApp(isolateApp);
  smtp.close();

  if (failures.length) {
    console.error('BAŞARISIZ\n' + failures.map(item => '- ' + item).join('\n'));
    process.exit(1);
  }
  console.log('TÜM TESTLER GEÇTİ');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
