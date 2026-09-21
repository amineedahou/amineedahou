// Rewrites the "latest projects" block in README.md from your public GitHub repos.
// Runs in GitHub Actions (Node 20+, no dependencies).
import { readFileSync, writeFileSync } from 'node:fs';

const USER = process.env.GH_USER || process.env.GITHUB_REPOSITORY_OWNER || 'amineedahou';
const COUNT = Number(process.env.PROJECT_COUNT || 6);
const EXCLUDE = (process.env.PROJECT_EXCLUDE || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const README = process.env.README_PATH || 'README.md';
const START = '<!-- START_SECTION:projects -->';
const END = '<!-- END_SECTION:projects -->';

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'profile-readme-projects',
  'X-GitHub-Api-Version': '2022-11-28',
};
if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;

const res = await fetch(
  `https://api.github.com/users/${USER}/repos?per_page=100&sort=pushed&type=owner`,
  { headers },
);
if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
const repos = await res.json();

const projects = repos
  .filter((r) => !r.fork && !r.archived && !r.private)
  .filter((r) => r.name.toLowerCase() !== USER.toLowerCase()) // skip the profile repo itself
  .filter((r) => !EXCLUDE.includes(r.name.toLowerCase()))
  .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
  .slice(0, COUNT);

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const shield = (s) => encodeURIComponent(s.replace(/-/g, '--').replace(/_/g, '__'));
const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// ---- description fallback: first paragraph of the repo's own README ----
const strip = (s) =>
  s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')       // images / badges
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // [text](url) -> text
    .replace(/<[^>]+>/g, '')                   // html tags
    .replace(/[`*~]/g, '')                     // code / bold / italic markers
    .replace(/^>\s?/, '')                      // blockquote marker
    .replace(/\s+/g, ' ')
    .trim();

function firstParagraph(md) {
  const lines = md.replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  let inFence = false;
  let buf = [];
  const flush = () => {
    const text = buf.join(' ').replace(/\s+/g, ' ').trim();
    buf = [];
    return text.length >= 15 ? text : '';
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      const t = flush();
      if (t) return t;
      continue;
    }
    if (inFence) continue;
    const isBreak =
      !line ||
      /^#{1,6}\s/.test(line) ||                       // markdown headings
      /^(={2,}|-{3,}|\*{3,}|_{3,})$/.test(line) ||    // underlines / rules
      /^([-*+]|\d+\.)\s/.test(line) ||                // list items
      line.startsWith('|') ||                         // tables
      /^<h[1-6][\s>]/i.test(line);                    // html headings
    if (isBreak) {
      const t = flush();
      if (t) return t;
      continue;
    }
    if (/^>\s*\[!/.test(line)) continue;              // GitHub alert blocks
    const text = strip(line);
    if (text) buf.push(text);
    else {
      const t = flush();                              // badge/image-only line
      if (t) return t;
    }
  }
  return flush();
}

const clip = (s, n = 140) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, '')}…`);

async function readmeSummary(name) {
  try {
    const r = await fetch(`https://api.github.com/repos/${USER}/${name}/readme`, {
      headers: { ...headers, Accept: 'application/vnd.github.raw+json' },
    });
    if (!r.ok) return '';
    return clip(firstParagraph(await r.text()));
  } catch {
    return '';
  }
}

// GitHub "About" description wins; otherwise use the README's first paragraph.
for (const p of projects) p.summary = p.description || (await readmeSummary(p.name));

function card(r) {
  const badges = [];
  if (r.language) {
    badges.push(`<img src="https://img.shields.io/badge/${shield(r.language)}-38bdf8?style=flat-square" alt="${esc(r.language)}" />`);
  }
  if (r.stargazers_count > 0) {
    badges.push(`<img src="https://img.shields.io/github/stars/${USER}/${r.name}?style=flat-square&color=0f172a&labelColor=38bdf8" alt="Stars" />`);
  }
  const links = [];
  if (r.homepage && /^https?:\/\//i.test(r.homepage)) {
    links.push(`<a href="${esc(r.homepage)}"><img src="https://img.shields.io/badge/Live_demo-38bdf8?style=flat-square" alt="Live demo" /></a>`);
  }
  links.push(`<a href="${r.html_url}"><img src="https://img.shields.io/badge/Source_code-0f172a?style=flat-square&logo=github" alt="Source code" /></a>`);

  return [
    '    <td width="50%" valign="top">',
    `      <h3><a href="${r.html_url}">${esc(r.name)}</a></h3>`,
    `      <p>${r.summary ? esc(r.summary) : 'No description yet.'}</p>`,
    badges.length ? `      ${badges.join('\n      ')}\n      <br/><br/>` : '',
    `      ${links.join('\n      ')}`,
    `      <br/><sub>Updated ${fmtDate(r.pushed_at)}</sub>`,
    '    </td>',
  ].filter(Boolean).join('\n');
}

let block;
if (projects.length === 0) {
  block = '<p align="center"><sub>No public projects yet. Check back soon.</sub></p>';
} else {
  const rows = [];
  for (let i = 0; i < projects.length; i += 2) {
    const pair = projects.slice(i, i + 2).map(card);
    if (pair.length === 1) pair.push('    <td width="50%"></td>');
    rows.push(`  <tr>\n${pair.join('\n')}\n  </tr>`);
  }
  block = `<table align="center">\n${rows.join('\n')}\n</table>`;
}

const readme = readFileSync(README, 'utf8');
const from = readme.indexOf(START);
const to = readme.indexOf(END);
if (from === -1 || to === -1 || to < from) {
  throw new Error(`Markers not found in ${README}. Add ${START} and ${END} where the projects should appear.`);
}
const next = `${readme.slice(0, from + START.length)}\n${block}\n${readme.slice(to)}`;

if (next === readme) {
  console.log('Projects already up to date.');
} else {
  writeFileSync(README, next);
  console.log(`Updated ${projects.length} project(s): ${projects.map((p) => p.name).join(', ') || 'none'}`);
}
