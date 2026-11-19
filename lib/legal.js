'use strict';

const fs = require('fs');
const path = require('path');

const LEGAL_DIR = path.join(__dirname, '..', 'legal');
const KVKK_VERSION = '2026-11-19';

const PAGE_META = {
  '/kvkk': { file: 'aydinlatma-metni.md', title: 'KVKK Aydınlatma Metni' },
  '/gizlilik': { file: 'gizlilik-politikasi.md', title: 'Gizlilik Politikası' },
  '/cerez': { file: 'cerez-politikasi.md', title: 'Çerez Politikası' }
};

const LINK_MAP = new Map([
  ['./aydinlatma-metni.md', '/kvkk'],
  ['aydinlatma-metni.md', '/kvkk'],
  ['/aydinlatma-metni', '/kvkk'],
  ['./gizlilik-politikasi.md', '/gizlilik'],
  ['gizlilik-politikasi.md', '/gizlilik'],
  ['/gizlilik-politikasi', '/gizlilik'],
  ['./cerez-politikasi.md', '/cerez'],
  ['cerez-politikasi.md', '/cerez'],
  ['/cerez-politikasi', '/cerez']
]);

const DROPPED_HREFS = new Set([
  './veri-envanteri.md',
  'veri-envanteri.md',
  '/veri-envanteri.md',
  '/veri-envanteri'
]);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveHref(href) {
  const raw = String(href || '').trim();
  if (DROPPED_HREFS.has(raw)) return null;
  if (LINK_MAP.has(raw)) return LINK_MAP.get(raw);
  if (/^(javascript|data|vbscript):/i.test(raw)) return null;
  if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)) return raw;
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes(':')) return raw;
  return null;
}

function renderInline(text) {
  const source = String(text);
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let match;
  const parts = [];
  while ((match = pattern.exec(source))) {
    if (match.index > last) parts.push(escapeHtml(source.slice(last, match.index)));
    if (match[1] != null) {
      const label = escapeHtml(match[1]);
      const href = resolveHref(match[2]);
      parts.push(href ? `<a href="${escapeHtml(href)}">${label}</a>` : label);
    } else if (match[3] != null) {
      parts.push(`<strong>${escapeHtml(match[3])}</strong>`);
    } else {
      parts.push(`<code>${escapeHtml(match[4])}</code>`);
    }
    last = match.index + match[0].length;
  }
  if (last < source.length) parts.push(escapeHtml(source.slice(last)));
  return parts.join('');
}

function isTableSeparator(line) {
  return /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);
}

function splitRow(line) {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split('|').map(cell => cell.trim());
}

function headingLevel(line) {
  const match = /^(#{1,6})\s+(.+)$/.exec(line);
  return match ? { level: match[1].length, text: match[2].trim() } : null;
}

function renderBlocks(source) {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let index = 0;

  function takeWhile(predicate) {
    const taken = [];
    while (index < lines.length && predicate(lines[index], taken)) {
      taken.push(lines[index]);
      index += 1;
    }
    return taken;
  }

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = headingLevel(line);
    if (heading) {
      html.push(`<h${heading.level}>${renderInline(heading.text)}</h${heading.level}>`);
      index += 1;
      continue;
    }

    if (line.trim().startsWith('>')) {
      const quoted = takeWhile(current => current.trim().startsWith('>') || (current.trim() === '' && lines[index + 1]?.trim().startsWith('>')));
      const inner = quoted.map(item => item.replace(/^\s*>\s?/, '')).join('\n');
      html.push(`<blockquote>${renderBlocks(inner)}</blockquote>`);
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const header = splitRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && !isTableSeparator(lines[index])) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      const head = `<tr>${header.map(cell => `<th>${renderInline(cell)}</th>`).join('')}</tr>`;
      const body = rows.map(row => `<tr>${row.map(cell => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('');
      html.push(`<div class="legal-table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = takeWhile(current => /^\s*[-*]\s+/.test(current));
      html.push(`<ul>${items.map(item => `<li>${renderInline(item.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`);
      continue;
    }

    const paragraph = takeWhile(current => {
      if (!current.trim()) return false;
      if (headingLevel(current)) return false;
      if (current.trim().startsWith('>')) return false;
      if (/^\s*[-*]\s+/.test(current)) return false;
      if (current.includes('|') && isTableSeparator(lines[index + 1] || '')) return false;
      return true;
    });
    html.push(`<p>${paragraph.map(item => renderInline(item)).join('<br>')}</p>`);
  }

  return html.join('');
}

function renderMarkdown(source) {
  return renderBlocks(source);
}

const PAGE_STYLES = `
:root,html.theme-verse{
  --bg-main:#07080d; --bg-card:#12131a; --bg-input:#1c1e28;
  --primary:#ff4d8d; --primary-deep:#e11d6a; --primary-glow:rgba(255,77,141,.38); --primary-soft:rgba(255,77,141,.16);
  --accent:#1fbf86; --text-main:#f7f7fb; --text-muted:#a3a8ba; --border:#262833; --border-light:#3a3d4d;
  --glow-a:rgba(255,77,141,.22); --glow-b:rgba(31,191,134,.14);
  --surface-1:#1a1c27;
}
*{box-sizing:border-box;margin:0;padding:0;font-family:'Inter',system-ui,sans-serif}
body{background:var(--bg-main);background-image:radial-gradient(ellipse 80% 46% at 50% -18%,var(--glow-a),transparent),radial-gradient(ellipse 50% 36% at 100% 100%,var(--glow-b),transparent);color:var(--text-main);min-height:100vh;display:flex;flex-direction:column;padding-top:env(safe-area-inset-top,0);padding-bottom:env(safe-area-inset-bottom,0)}
header{background:color-mix(in srgb,var(--bg-card) 82%,transparent);backdrop-filter:blur(16px);border-bottom:1px solid var(--border-light);padding:.7rem 1.5rem;padding-top:calc(.7rem + env(safe-area-inset-top,0))}
.brand-logo{height:58px;width:auto;max-width:min(320px,62vw);object-fit:contain;filter:drop-shadow(0 8px 16px var(--primary-glow))}
h1,h2,h3,.site-footer{font-family:'Outfit','Inter',system-ui,sans-serif}
.container{max-width:860px;margin:1.75rem auto;padding:0 1rem;width:100%;flex:1}
.card{background:linear-gradient(180deg,color-mix(in srgb,var(--surface-1) 88%,var(--primary) 12%),var(--bg-card));border:1px solid var(--border-light);border-radius:20px;padding:1.5rem 1.6rem 2rem;box-shadow:0 16px 40px rgba(0,0,0,.32)}
.legal-body{line-height:1.65;font-size:.95rem}
.legal-body h1{font-size:1.7rem;font-weight:800;color:var(--primary);margin:0 0 1rem}
.legal-body h2{font-size:1.15rem;font-weight:700;color:var(--primary);margin:1.6rem 0 .7rem}
.legal-body h3{font-size:1rem;font-weight:700;margin:1.2rem 0 .5rem}
.legal-body p,.legal-body li{color:var(--text-main)}
.legal-body p{margin:0 0 .85rem}
.legal-body ul{margin:0 0 1rem 1.2rem}
.legal-body li{margin:.25rem 0}
.legal-body a{color:var(--primary)}
.legal-body strong{font-weight:700}
.legal-body code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;padding:.05rem .35rem}
.legal-body blockquote{border-left:3px solid var(--primary);background:var(--primary-soft);padding:.85rem 1rem;border-radius:0 12px 12px 0;margin:0 0 1.1rem;color:var(--text-muted)}
.legal-body blockquote p:last-child{margin-bottom:0}
.legal-table-wrap{overflow-x:auto;margin:0 0 1.1rem}
.legal-body table{width:100%;border-collapse:collapse;font-size:.86rem}
.legal-body th,.legal-body td{border:1px solid var(--border-light);padding:.55rem .7rem;text-align:left;vertical-align:top}
.legal-body th{background:var(--bg-input);color:var(--primary);font-weight:700}
.site-footer{margin-top:auto;padding:1.25rem 1rem calc(1.25rem + env(safe-area-inset-bottom,0));display:flex;flex-wrap:wrap;justify-content:center;gap:1rem;border-top:1px solid var(--border);font-size:.82rem}
.site-footer a{color:var(--text-muted);text-decoration:none}
.site-footer a:hover{color:var(--primary);text-decoration:underline}
`.trim();

function wrapPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="tr" class="theme-verse">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${escapeHtml(title)} · Omni.verse</title>
  <link rel="icon" href="/brand/verse.png" type="image/png">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;700;800&display=swap" rel="stylesheet">
  <style>
${PAGE_STYLES}
  </style>
</head>
<body>
  <header>
    <div class="brand"><a href="/"><img class="brand-logo" src="/brand/verse.png" alt="Omni.verse"></a></div>
  </header>
  <main class="container">
    <article class="card legal-body">
${bodyHtml}
    </article>
  </main>
  <footer class="site-footer">
    <a href="/kvkk">Aydınlatma Metni</a>
    <a href="/gizlilik">Gizlilik Politikası</a>
    <a href="/cerez">Çerez Politikası</a>
  </footer>
</body>
</html>
`;
}

function loadPages() {
  const pages = {};
  for (const [route, meta] of Object.entries(PAGE_META)) {
    const source = fs.readFileSync(path.join(LEGAL_DIR, meta.file), 'utf8');
    pages[route] = wrapPage(meta.title, renderMarkdown(source));
  }
  return pages;
}

const legalPages = loadPages();

module.exports = {
  legalPages,
  renderMarkdown,
  resolveHref,
  PAGE_META,
  KVKK_VERSION
};
