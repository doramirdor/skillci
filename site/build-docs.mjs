// Build the hosted docs site: docs/*.md -> site/docs/*.html
// Clean Apple/Airbnb-style template with a sticky sidebar. Run: npm run docs:build
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const DOCS = join(root, 'docs');
const OUT = join(here, 'docs');
mkdirSync(OUT, { recursive: true });

const REPO = 'https://github.com/doramirdor/skillci';

const pages = [
  { src: 'README.md',          slug: 'index',           label: 'Overview' },
  { src: 'getting-started.md', slug: 'getting-started', label: 'Getting Started' },
  { src: 'concepts.md',        slug: 'concepts',        label: 'Concepts' },
  { src: 'cli-reference.md',   slug: 'cli-reference',   label: 'CLI Reference' },
  { src: 'writing-tasks.md',   slug: 'writing-tasks',   label: 'Writing Tasks' },
  { src: 'scoring.md',         slug: 'scoring',         label: 'Scoring' },
  { src: 'agents-and-auth.md', slug: 'agents-and-auth', label: 'Agents & Auth' },
  { src: 'ci-integration.md',  slug: 'ci-integration',  label: 'CI Integration' },
  { src: 'architecture.md',    slug: 'architecture',    label: 'Architecture' },
  { src: 'troubleshooting.md', slug: 'troubleshooting', label: 'Troubleshooting' },
];

marked.setOptions({ gfm: true });

const fileFor = (slug) => `${slug}.html`;

function rewriteHref(href) {
  if (/^(https?:|#|mailto:)/.test(href)) return href;
  if (href.startsWith('../')) return `${REPO}/blob/main/${href.slice(3)}`;
  const h = href.replace(/^\.\//, '');
  const m = h.match(/^([^#]+)\.md(#.*)?$/);
  if (m) {
    let base = m[1];
    if (base.toLowerCase() === 'readme') base = 'index';
    return base + '.html' + (m[2] || '');
  }
  return href;
}

function slugify(text) {
  return text.replace(/<[^>]+>/g, '').trim().toLowerCase()
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
}

function addHeadingIds(html) {
  return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g,
    (m, lvl, inner) => `<h${lvl} id="${slugify(inner)}">${inner}</h${lvl}>`);
}

function rewriteLinks(html) {
  return html.replace(/href="([^"]+)"/g, (m, h) => `href="${rewriteHref(h)}"`);
}

function sidebar(currentSlug) {
  return pages.map((p) => {
    const active = p.slug === currentSlug ? ' class="active"' : '';
    return `      <a href="${fileFor(p.slug)}"${active}>${p.label}</a>`;
  }).join('\n');
}

function pager(prev, next) {
  const cell = (p, kind) =>
    p ? `<a class="${kind}" href="${fileFor(p.slug)}"><span class="k">${kind === 'nxt' ? 'Next' : 'Previous'}</span><span class="t">${p.label}</span></a>`
      : '<span></span>';
  return `<nav class="doc-pager">${cell(prev, 'prv')}${cell(next, 'nxt')}</nav>`;
}

const DOC_CSS = `
.doc-shell{max-width:1200px;margin:0 auto;padding:96px 24px 64px;display:grid;grid-template-columns:236px 1fr;gap:52px}
.doc-side{position:sticky;top:84px;align-self:start}
.doc-side .lbl{font-size:11.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--ink-3);font-weight:600;margin:0 0 12px;padding-left:12px}
.doc-side a{display:block;padding:8px 12px;border-radius:8px;color:var(--ink-2);font-size:14.5px;font-weight:500;border-left:2px solid transparent}
.doc-side a:hover{background:rgba(0,0,0,.04);color:var(--ink);text-decoration:none}
.doc-side a.active{color:var(--accent-ink);background:#eef0fe;font-weight:600}
.doc-main{min-width:0}
.doc{max-width:760px}
.doc>:first-child{margin-top:0}
.doc h1{font-size:clamp(32px,4.5vw,44px);line-height:1.1;letter-spacing:-.025em;font-weight:700;margin:0 0 22px}
.doc h2{font-size:24px;letter-spacing:-.015em;font-weight:650;margin:46px 0 14px;padding-top:26px;border-top:1px solid var(--line-2);scroll-margin-top:80px}
.doc h3{font-size:18.5px;font-weight:650;margin:30px 0 10px;scroll-margin-top:80px}
.doc p,.doc li{font-size:16.5px;line-height:1.75;color:#2b2b2f}
.doc a{color:var(--accent);font-weight:500}
.doc strong{color:var(--ink);font-weight:650}
.doc ul,.doc ol{padding-left:22px}.doc li{margin:6px 0}
.doc code{font-family:var(--mono);font-size:.85em;background:var(--code-bg);padding:2px 6px;border-radius:6px;color:var(--ink)}
.doc pre{background:var(--code-bg);border:1px solid var(--line-2);border-radius:12px;padding:18px 20px;overflow-x:auto;margin:18px 0}
.doc pre code{background:none;padding:0;font-size:13.5px;line-height:1.65;color:#1d1d1f}
.doc blockquote{margin:18px 0;padding:6px 18px;border-left:3px solid var(--accent);color:var(--ink-2);background:#fafaff;border-radius:0 10px 10px 0}
.doc blockquote p{margin:6px 0}
.doc table{width:100%;border-collapse:collapse;margin:18px 0;font-size:15px;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.doc th,.doc td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line-2);vertical-align:top}
.doc th{background:#fcfcfd;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3);font-weight:600}
.doc tr:last-child td{border-bottom:0}
.doc hr{border:0;border-top:1px solid var(--line-2);margin:36px 0}
.doc img{max-width:100%;border-radius:10px}
.doc-pager{display:flex;justify-content:space-between;gap:16px;margin-top:56px;padding-top:24px;border-top:1px solid var(--line-2)}
.doc-pager>a{flex:1;border:1px solid var(--line);border-radius:12px;padding:14px 18px;color:var(--ink);transition:box-shadow .2s var(--ease),border-color .2s var(--ease)}
.doc-pager>a:hover{box-shadow:var(--shadow-sm);border-color:rgba(0,0,0,.22);text-decoration:none}
.doc-pager .nxt{text-align:right}
.doc-pager .k{display:block;font-size:12px;color:var(--ink-3);margin-bottom:3px}
.doc-pager .t{font-weight:600;font-size:15px}
@media(max-width:900px){.doc-shell{grid-template-columns:1fr;gap:22px;padding-top:84px}
  .doc-side{position:static;display:flex;flex-wrap:wrap;gap:6px;padding-bottom:18px;border-bottom:1px solid var(--line-2)}
  .doc-side .lbl{width:100%}.doc-side a{border-left:0}}
`;

function tpl({ title, label, slug, body, prev, next }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · SkillCI Docs</title>
<meta name="description" content="SkillCI documentation — ${label}." />
<link rel="icon" type="image/svg+xml" href="../assets/logo.svg" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="../styles.css" />
<style>${DOC_CSS}</style>
</head>
<body>
<header class="nav"><div class="inner">
  <a class="brand" href="../"><img src="../assets/logo.svg" alt="" /> Skill<b>CI</b></a>
  <span class="sp"></span>
  <nav class="links">
    <a href="index.html">Docs</a>
    <a class="cta" href="${REPO}">GitHub</a>
  </nav>
</div></header>

<div class="doc-shell">
  <aside class="doc-side">
    <p class="lbl">Documentation</p>
${sidebar(slug)}
  </aside>
  <main class="doc-main">
    <article class="doc">
${body}
    </article>
    ${pager(prev, next)}
  </main>
</div>

<footer class="footer"><div class="inner">
  <img src="../assets/logo.svg" alt="" />
  <span>SkillCI — CI for your AI config</span>
  <span class="sp"></span>
  <a href="../">Home</a>
  <a href="${REPO}">GitHub</a>
  <a href="${REPO}/blob/main/LICENSE">MIT</a>
</div></footer>
</body>
</html>
`;
}

let count = 0;
for (let i = 0; i < pages.length; i++) {
  const p = pages[i];
  const md = readFileSync(join(DOCS, p.src), 'utf8');
  let body = marked.parse(md);
  body = addHeadingIds(body);
  body = rewriteLinks(body);
  const html = tpl({
    title: p.slug === 'index' ? 'Documentation' : p.label,
    label: p.label,
    slug: p.slug,
    body,
    prev: i > 0 ? pages[i - 1] : null,
    next: i < pages.length - 1 ? pages[i + 1] : null,
  });
  writeFileSync(join(OUT, fileFor(p.slug)), html);
  count++;
}
console.log(`Built ${count} doc pages into site/docs/`);
