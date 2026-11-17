const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'tour-maker.html'), 'utf8');
const keys = [
  'modeTitle', 'modeSubtitle', 'modeOfflineKicker', 'modeOffline', 'modeOfflineDesc',
  'modeOnlineKicker', 'modeOnline', 'modeOnlineDesc', 'mainMenu',
  'onlineTitle', 'onlineSubtitle', 'comingSoon',
  'onlineLeagues', 'onlineLeaguesDesc', 'onlineShop', 'onlineShopDesc',
  'onlinePlayerMarket', 'onlinePlayerMarketDesc', 'onlineOmniMarket', 'onlineOmniMarketDesc',
  'coin', 'omniDollar'
];

function loadLocales() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync(path.join(root, 'locale.js'), 'utf8')}\nglobalThis.I18N = I18N;`, context);
  return context.I18N;
}

test('every locale has the mode and online hub copy', () => {
  const locales = loadLocales();
  const codes = ['tr', 'en', 'es', 'ru', 'nl', 'de', 'az'];
  assert.deepEqual(Object.keys(locales).sort(), [...codes].sort());
  for (const code of codes) {
    for (const key of keys) {
      assert.equal(typeof locales[code][key], 'string', `${code}.${key}`);
      assert.notEqual(locales[code][key].trim(), '', `${code}.${key}`);
      assert.equal(locales[code][key].includes('$'), false, `${code}.${key} must not use $`);
    }
    assert.equal(locales.tr.modeOffline, 'Offline');
    assert.equal(locales.tr.modeOnline, 'Online (Rekabetçi)');
    assert.equal(locales.tr.mainMenu, 'Ana Menü');
    assert.equal(locales.tr.comingSoon, 'Yakında');
    assert.match(locales[code].omniDollar, /^Omni /);
  }
});

test('mode gate, online hub, and theme logos are in the page', () => {
  assert.match(html, /dataset\.appMode = 'menu'/);
  assert.match(html, /id="modeView"/);
  assert.match(html, /id="onlineView"/);
  assert.match(html, /id="mainMenuBtn"/);
  assert.match(html, /onclick="enterOfflineMode\(\)"/);
  assert.match(html, /onclick="enterOnlineMode\(\)"/);
  assert.match(html, /onclick="showModeMenu\(\)"/);
  assert.match(html, /id="balanceBar"/);
  assert.match(html, /balance-coin/);
  assert.match(html, /balance-omni/);
  assert.match(html, /Ⓞ/);
  assert.equal((html.match(/<img[^>]*data-brand-logo/g) || []).length, 3);
  const balance = html.slice(html.indexOf('id="balanceBar"'), html.indexOf('id="mainMenuBtn"'));
  assert.equal(balance.includes('$'), false);
  assert.match(balance, /id="coinBalance">—</);
  assert.match(balance, /id="omniBalance">—</);
  assert.equal(html.includes('onlinePlaceholderBalances'), false);
  assert.equal(/html:not\(\[data-app-mode="offline"\]\) #banLock/.test(html), false);
  assert.match(html, /html:not\(\[data-app-mode="offline"\]\) #paymentModal/);
  assert.match(html, /id="dashboardView"/);
  assert.match(html, /id="publicPackageList"/);
  assert.match(html, /id="dashboardPackageList"/);
  assert.match(html, /data-i18n="shopTitle"/);
});
