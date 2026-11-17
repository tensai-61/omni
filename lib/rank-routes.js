const crypto = require('crypto');
const {
  assignRole,
  setupTwoFactor,
  confirmTwoFactor,
  verifyFactor,
  disableTwoFactor,
  resetTwoFactor,
  setMute,
  clearMute,
  postChat,
  createReport,
  listReports,
  supportProfile,
  listAudit,
  rankOf,
  writeAudit,
  withImmediate,
  assertOutranks,
  assertTwoFactor
} = require('./ranks');
const { applyBalanceChange, balancesOf } = require('./online-league');

function asId(value) {
  if (typeof value === 'bigint') value = Number(value);
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function loadTarget(database, id) {
  const user = database.prepare('SELECT id, email, username, role FROM users WHERE id = ?').get(asId(id));
  if (!user) return null;
  return { id: asId(user.id), email: user.email, username: user.username, role: user.role, rank: rankOf(database, user.id) };
}

function createHandler(deps) {
  const {
    database, appSecret, totpKey, sendJson, readJsonBody, requireSameOrigin, requireSession,
    requireRank, requestBodyLimit, clientAddress, confirmPassword
  } = deps;
  const factorKey = totpKey || appSecret;

  async function requirePassword(request, response, user, body) {
    const check = typeof confirmPassword === 'function' ? await confirmPassword(user.id, body?.password, request) : { ok: false };
    if (check?.ok === true) return true;
    sendJson(response, check?.locked ? 429 : 403, { ok: false, error: check?.error || 'Şifre hatalı' });
    return false;
  }

  async function requireFreshFactor(request, response, user, body) {
    if (!(await requirePassword(request, response, user, body))) return false;
    try {
      verifyFactor(database, user, body?.code, factorKey);
      return true;
    } catch (error) {
      if (response.headersSent) return false;
      const status = Number(error.status) || 403;
      sendJson(response, status, { ok: false, error: status === 500 ? 'Sunucu isteği tamamlayamadı' : error.message });
      return false;
    }
  }

  async function bodyOf(request, response, user, pathname) {
    if (!requireSameOrigin(request, response)) return null;
    return readJsonBody(request, response, requestBodyLimit(pathname, user));
  }

  return async function handleRankHttp(request, response, pathname) {
    const path = pathname.replace(/\/+$/, '') || '/';
    const mine = path.startsWith('/api/account/2fa')
      || path === '/api/chat'
      || path === '/api/reports'
      || path.startsWith('/api/mod/')
      || path.startsWith('/api/support/')
      || path === '/api/admin/audit'
      || /^\/api\/admin\/users\/\d+\/(role|balance|mute|unmute|2fa)$/.test(path)
      || /^\/api\/admin\/users\/\d+\/2fa\/reset$/.test(path);
    if (!mine) return false;
    try {
      if (path === '/api/account/2fa/setup' && request.method === 'POST') {
        const user = requireSession(request, response);
        if (!user) return true;
        const body = await bodyOf(request, response, user, path);
        if (body === null) return true;
        if (!(await requirePassword(request, response, user, body))) return true;
        const setup = setupTwoFactor(database, user, factorKey);
        sendJson(response, 200, { ok: true, ...setup });
        return true;
      }
      if (path === '/api/account/2fa/confirm' && request.method === 'POST') {
        const user = requireSession(request, response);
        if (!user) return true;
        const body = await bodyOf(request, response, user, path);
        if (body === null) return true;
        if (!(await requirePassword(request, response, user, body))) return true;
        confirmTwoFactor(database, user, body.code, factorKey, clientAddress(request));
        sendJson(response, 200, { ok: true, twoFactorEnabled: true });
        return true;
      }
      if (path === '/api/account/2fa/verify' && request.method === 'POST') {
        const user = requireSession(request, response);
        if (!user) return true;
        const body = await bodyOf(request, response, user, path);
        if (body === null) return true;
        const result = verifyFactor(database, user, body.code, factorKey);
        sendJson(response, 200, { ok: true, ...result });
        return true;
      }
      if (path === '/api/account/2fa/disable' && request.method === 'POST') {
        const user = requireSession(request, response);
        if (!user) return true;
        const body = await bodyOf(request, response, user, path);
        if (body === null) return true;
        if (user.rank === 'admin' || user.rank === 'moderator') {
          sendJson(response, 403, { ok: false, error: 'Admin ve moderatör iki adımlı doğrulamayı kapatamaz' });
          return true;
        }
        if (!(await requirePassword(request, response, user, body))) return true;
        disableTwoFactor(database, user, body.code, factorKey, clientAddress(request));
        sendJson(response, 200, { ok: true, twoFactorEnabled: false });
        return true;
      }
      if (path === '/api/chat' && request.method === 'POST') {
        const user = requireSession(request, response);
        if (!user) return true;
        const body = await bodyOf(request, response, user, path);
        if (body === null) return true;
        sendJson(response, 201, { ok: true, message: postChat(database, user, body.text) });
        return true;
      }
      if (path === '/api/reports' && request.method === 'POST') {
        const user = requireSession(request, response);
        if (!user) return true;
        const body = await bodyOf(request, response, user, path);
        if (body === null) return true;
        sendJson(response, 201, { ok: true, report: createReport(database, user, body.targetId, body.reason) });
        return true;
      }
      if (path === '/api/mod/reports' && request.method === 'GET') {
        const user = requireRank(request, response, 'moderator');
        if (!user) return true;
        sendJson(response, 200, { reports: listReports(database) });
        return true;
      }
      if (path === '/api/admin/audit') {
        if (request.method === 'PUT' || request.method === 'DELETE' || request.method === 'PATCH') {
          sendJson(response, 405, { ok: false, error: 'Denetim kaydı değiştirilemez' });
          return true;
        }
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' });
          response.end('Method not allowed');
          return true;
        }
        const user = requireRank(request, response, 'admin');
        if (!user) return true;
        const url = new URL(request.url, 'http://localhost');
        sendJson(response, 200, listAudit(database, {
          page: url.searchParams.get('page'),
          pageSize: url.searchParams.get('pageSize'),
          action: url.searchParams.get('action') || '',
          actorId: url.searchParams.get('actorId'),
          targetId: url.searchParams.get('targetId')
        }));
        return true;
      }
      const supportMatch = path.match(/^\/api\/support\/users\/(\d+)$/);
      if (supportMatch && request.method === 'GET') {
        const user = requireRank(request, response, 'support');
        if (!user) return true;
        const profile = supportProfile(database, Number(supportMatch[1]));
        if (!profile) {
          sendJson(response, 404, { ok: false, error: 'Kullanıcı bulunamadı' });
          return true;
        }
        sendJson(response, 200, profile);
        return true;
      }
      const listingMatch = path.match(/^\/api\/mod\/listings\/(\d+)\/remove$/);
      if (listingMatch && request.method === 'POST') {
        const user = requireRank(request, response, 'moderator');
        if (!user) return true;
        const body = await bodyOf(request, response, user, path);
        if (body === null) return true;
        const listingId = Number(listingMatch[1]);
        const removed = withImmediate(database, () => {
          const listing = database.prepare('SELECT id, seller_id, status, price FROM player_market_listings WHERE id = ?').get(listingId);
          if (!listing) throw Object.assign(new Error('İlan bulunamadı'), { status: 404 });
          const target = loadTarget(database, listing.seller_id);
          assertOutranks(user, target, user.rank === 'moderator'
            ? 'Moderatör, moderatör veya yönetici ilanını kaldıramaz'
            : 'Yalnızca alt rütbelere işlem yapılabilir');
          if (listing.status !== 'active') throw Object.assign(new Error('İlan artık aktif değil'), { status: 409 });
          const now = new Date().toISOString();
          const updated = database.prepare(`
            UPDATE player_market_listings SET status = 'cancelled', closed_at = ? WHERE id = ? AND status = 'active'
          `).run(now, listingId);
          if (updated.changes !== 1) throw Object.assign(new Error('İlan artık aktif değil'), { status: 409 });
          writeAudit(database, {
            actorId: user.id,
            targetId: target.id,
            action: 'listing_remove',
            oldValue: { listingId, status: 'active', price: listing.price },
            newValue: { listingId, status: 'cancelled' },
            ip: clientAddress(request)
          });
          return { id: listingId, status: 'cancelled' };
        });
        sendJson(response, 200, { ok: true, listing: removed });
        return true;
      }
      const userAction = path.match(/^\/api\/admin\/users\/(\d+)\/(role|balance|mute|unmute|2fa\/reset)$/);
      if (userAction) {
        if (request.method !== 'POST') {
          response.writeHead(405, { Allow: 'POST' });
          response.end('Method not allowed');
          return true;
        }
        const action = userAction[2];
        const min = action === 'mute' || action === 'unmute' ? 'moderator' : 'admin';
        const user = requireRank(request, response, min);
        if (!user) return true;
        const body = await bodyOf(request, response, user, path);
        if (body === null) return true;
        const target = loadTarget(database, Number(userAction[1]));
        if (!target) {
          sendJson(response, 404, { ok: false, error: 'Kullanıcı bulunamadı' });
          return true;
        }
        const ip = clientAddress(request);
        if (action === 'role') {
          try {
            const result = assignRole(database, user, target, body.role, ip, { reauth: false });
            sendJson(response, 200, { ok: true, ...result });
          } catch (error) {
            if (error.code !== 'reauth_required') throw error;
            if (!(await requireFreshFactor(request, response, user, body))) return true;
            const result = assignRole(database, user, target, body.role, ip, { reauth: true });
            sendJson(response, 200, { ok: true, ...result });
          }
          return true;
        }
        if (action === 'balance') {
          if (user.rank !== 'admin') {
            sendJson(response, 403, { ok: false, error: 'Bakiye düzeltmesi yalnızca yöneticiye açık' });
            return true;
          }
          assertTwoFactor(user);
          assertOutranks(user, target, 'Yalnızca alt rütbenin bakiyesi düzeltilebilir');
          const currency = body.currency === 'coin' || body.currency === 'omni' ? body.currency : '';
          const amount = Number(body.amount);
          const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
          if (!currency) {
            sendJson(response, 400, { ok: false, error: 'Para birimi geçersiz' });
            return true;
          }
          if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) {
            sendJson(response, 400, { ok: false, error: 'Tutar geçersiz' });
            return true;
          }
          if (reason.length < 3 || reason.length > 160) {
            sendJson(response, 400, { ok: false, error: 'Açıklama 3-160 karakter olmalı' });
            return true;
          }
          const result = withImmediate(database, () => {
            const before = balancesOf(database, target.id);
            const refKey = `admin-adjust:${target.id}:${crypto.randomBytes(8).toString('hex')}`;
            const applied = applyBalanceChange(database, target.id, amount, currency, reason, refKey, new Date().toISOString(), 'admin');
            const after = balancesOf(database, target.id);
            writeAudit(database, {
              actorId: user.id,
              targetId: target.id,
              action: 'balance_adjust',
              oldValue: before,
              newValue: { ...after, amount, currency, reason },
              ip
            });
            return { applied: applied.applied, before, after };
          });
          sendJson(response, 200, { ok: true, ...result });
          return true;
        }
        if (action === 'mute') {
          const result = setMute(database, user, target, body, ip);
          sendJson(response, 200, { ok: true, ...result });
          return true;
        }
        if (action === 'unmute') {
          const result = clearMute(database, user, target, ip);
          sendJson(response, 200, { ok: true, ...result });
          return true;
        }
        try {
          resetTwoFactor(database, user, target, ip, { reauth: false });
        } catch (error) {
          if (error.code !== 'reauth_required') throw error;
          if (!(await requireFreshFactor(request, response, user, body))) return true;
          resetTwoFactor(database, user, target, ip, { reauth: true });
        }
        sendJson(response, 200, { ok: true, twoFactorEnabled: false });
        return true;
      }
      sendJson(response, 404, { ok: false, error: 'API bulunamadı' });
      return true;
    } catch (error) {
      if (response.headersSent) return true;
      const status = Number(error.status) || 500;
      if (status === 500) console.error('Rütbe isteği başarısız:', error.code || error.name);
      sendJson(response, status, {
        ok: false,
        error: status === 500 ? 'Sunucu isteği tamamlayamadı' : error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.setupPath ? { setupPath: error.setupPath } : {})
      });
      return true;
    }
  };
}

module.exports = { createHandler };
