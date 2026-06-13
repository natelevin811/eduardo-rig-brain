// build-site.mjs — render the docs + artifacts into a self-contained static
// site for Vercel. Modern Node (ESM); runs as `npm run build`. Output -> site/.
//
// This is doc hosting only — it touches nothing in the rig. The Max devices,
// the resolver, and the Link contract are unaffected by anything in here.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site');

marked.setOptions({ gfm: true, breaks: false, headerIds: true, mangle: false });

// Which docs to publish, in order, with a short blurb for the landing page.
const DOCS = [
  { src: 'docs/EXPLAINER.html', slug: 'explainer', title: 'What the rig is', raw: true,
    blurb: 'The illustrated tour — two brains, the Link safety contract, and the failure-recovery war stories.', tag: 'artifact' },
  { src: 'docs/RUNBOOK-KEYMAP.md', slug: 'keymap', title: 'Keymap & controls',
    blurb: 'Every command clip, both device faces, dashboard hotkeys, and what is safe to move or rename.', tag: 'runbook' },
  { src: 'README.md', slug: 'readme', title: 'README',
    blurb: 'Repository overview and the shape of the build.', tag: 'start here' },
  { src: 'docs/SPEC.md', slug: 'spec', title: 'Specification',
    blurb: 'The full build spec: safeguards, the Link contract, the phase plan, the test plan.', tag: 'spec' },
  { src: 'docs/RUNBOOK.md', slug: 'runbook', title: 'Show runbook',
    blurb: 'The original at-the-gig runbook.', tag: 'runbook' },
  { src: 'docs/CALIBRATION.md', slug: 'calibration', title: 'Calibration',
    blurb: 'The C0–C10 calibration pass — what to confirm by ear and eye in the room.', tag: 'setup' },
  { src: 'docs/RIG-TEST.md', slug: 'rig-test', title: 'Rig test plan',
    blurb: 'The full on-rig test sweep.', tag: 'test' },
  { src: 'docs/SHELL-BUILD.md', slug: 'shell-build', title: 'Shell build',
    blurb: 'Building the Max device shells and prepping the Live set.', tag: 'build' },
  { src: 'STATUS.md', slug: 'status', title: 'Build status',
    blurb: 'The living status log — what is done, untested, and needs human hands.', tag: 'log' }
];

const STYLE = `
  :root{--bg:#0b0d10;--bg2:#0f1318;--panel:#141a21;--panel2:#1a212a;--line:#222b35;--line2:#2c3845;
    --txt:#e8edf2;--txt2:#aab6c2;--dim:#6b7886;--dim2:#4a5562;--teal:#46a89e;--teal-d:#2e6b64;
    --amber:#e0a23f;--violet:#8a6fc0;--rust:#c05c30;--red:#d24a38;
    --disp:'Bricolage Grotesque',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace;}
  *{box-sizing:border-box}html{scroll-behavior:smooth}
  body{margin:0;background:radial-gradient(1100px 600px at 80% -10%,rgba(70,168,158,.08),transparent 60%),
    radial-gradient(800px 500px at 10% 2%,rgba(224,162,63,.05),transparent 55%),var(--bg);
    color:var(--txt);font-family:var(--disp);line-height:1.6;-webkit-font-smoothing:antialiased}
  a{color:var(--teal);text-decoration:none}a:hover{text-decoration:underline}
  code,.mono{font-family:var(--mono);font-size:.9em}
  .topbar{position:sticky;top:0;z-index:10;backdrop-filter:blur(8px);
    background:rgba(11,13,16,.72);border-bottom:1px solid var(--line)}
  .topbar .in{max-width:880px;margin:0 auto;padding:13px 24px;display:flex;align-items:center;gap:16px}
  .topbar a.home{font-weight:700;color:var(--txt);letter-spacing:-.01em}
  .topbar .crumb{color:var(--dim);font-size:13px}
  .topbar .spacer{margin-left:auto}
  .topbar .chip{font-family:var(--mono);font-size:11px;letter-spacing:.04em;color:var(--txt2);
    border:1px solid var(--line2);border-radius:999px;padding:5px 12px}
  main{max-width:880px;margin:0 auto;padding:40px 24px 14vh}
  main h1{font-size:clamp(30px,5vw,46px);font-weight:800;letter-spacing:-.02em;margin:.4em 0 .3em}
  main h2{font-size:clamp(22px,3vw,30px);font-weight:700;margin:1.8em 0 .4em;padding-bottom:.25em;border-bottom:1px solid var(--line)}
  main h3{font-size:19px;font-weight:700;margin:1.5em 0 .3em}
  main h4{font-size:16px;font-weight:700;color:var(--txt2);margin:1.3em 0 .2em}
  main p,main li{color:var(--txt2)}main strong{color:var(--txt)}
  main a{border-bottom:1px solid transparent}main a:hover{border-color:var(--teal)}
  main ul,main ol{padding-left:22px}main li{margin:.3em 0}
  main code{background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:1px 5px;color:#cfe6e2}
  main pre{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:16px 18px;overflow:auto}
  main pre code{background:none;border:none;padding:0;color:var(--txt2);font-size:13px;line-height:1.55}
  main blockquote{margin:1em 0;padding:.4em 16px;border-left:3px solid var(--amber);background:rgba(224,162,63,.05);
    border-radius:0 8px 8px 0;color:var(--txt2)}
  main blockquote p{margin:.3em 0;color:#e6d6c4}
  main table{width:100%;border-collapse:collapse;margin:1.2em 0;font-size:14.5px;display:block;overflow:auto}
  main th,main td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  main th{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);font-weight:400;white-space:nowrap}
  main td code{white-space:nowrap}
  main hr{border:none;border-top:1px solid var(--line);margin:2.4em 0}
  main h1,main h2,main h3{scroll-margin-top:70px}
`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">`;

function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function docPage(title, tag, innerHtml){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Eduardo rig brain</title>${FONTS}<style>${STYLE}</style></head>
<body>
<div class="topbar"><div class="in">
  <a class="home" href="/">↩ Rig brain</a>
  <span class="crumb">${esc(title)}</span>
  <span class="spacer"></span><span class="chip">${esc(tag)}</span>
</div></div>
<main>${innerHtml}</main>
</body></html>`;
}

function landing(items){
  const cards = items.map(d => `
    <a class="card" href="/${d.slug}">
      <div class="tag">${esc(d.tag)}</div>
      <h3>${esc(d.title)}</h3>
      <p>${esc(d.blurb)}</p>
    </a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eduardo rig brain — docs &amp; artifacts</title>${FONTS}<style>${STYLE}
  .hero{max-width:880px;margin:0 auto;padding:13vh 24px 6vh;border-bottom:1px solid var(--line)}
  .hero .kick{font-family:var(--mono);font-size:12px;letter-spacing:.32em;text-transform:uppercase;color:var(--teal);margin-bottom:18px}
  .hero h1{font-size:clamp(36px,6.5vw,68px);font-weight:800;line-height:1.04;letter-spacing:-.02em;margin:0 0 18px}
  .hero h1 .g{background:linear-gradient(96deg,var(--teal),var(--amber));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .hero p{font-size:clamp(16px,2vw,21px);color:var(--txt2);max-width:48ch;margin:0}
  .grid{max-width:880px;margin:0 auto;padding:6vh 24px 14vh;display:grid;grid-template-columns:1fr 1fr;gap:18px}
  @media(max-width:720px){.grid{grid-template-columns:1fr}}
  a.card{display:block;background:linear-gradient(180deg,var(--panel),var(--bg2));border:1px solid var(--line);
    border-radius:16px;padding:22px 24px;transition:transform .16s,border-color .16s;text-decoration:none}
  a.card:hover{transform:translateY(-2px);border-color:var(--teal-d)}
  a.card .tag{font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--teal);margin-bottom:10px}
  a.card h3{margin:0 0 6px;font-size:20px;font-weight:700;color:var(--txt)}
  a.card p{margin:0;font-size:14.5px;color:var(--txt2);line-height:1.5}
  .foot{max-width:880px;margin:0 auto;padding:0 24px 12vh;color:var(--dim);font-size:13px;font-family:var(--mono)}
</style></head>
<body>
<div class="hero">
  <div class="kick">Eduardo · live ambient looping rig</div>
  <h1>Two small brains,<br><span class="g">one safety contract</span>,<br>and the docs that explain them.</h1>
  <p>Devices, dashboard, and the failure-recovery story behind a rig built so reliability outranks every feature.</p>
</div>
<div class="grid">${cards}</div>
<div class="foot">Static mirror of the repository docs &amp; artifacts. The live telemetry dashboard runs on the rig at localhost:7777.</div>
</body></html>`;
}

// ---- build ----
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const published = [];
for (const d of DOCS) {
  const abs = join(ROOT, d.src);
  if (!existsSync(abs)) { console.warn('skip (missing): ' + d.src); continue; }
  if (d.raw) {
    copyFileSync(abs, join(OUT, d.slug + '.html'));
  } else {
    const md = readFileSync(abs, 'utf8');
    const inner = marked.parse(md);
    writeFileSync(join(OUT, d.slug + '.html'), docPage(d.title, d.tag, inner));
  }
  published.push(d);
  console.log('built /' + d.slug + '  <-  ' + d.src);
}

writeFileSync(join(OUT, 'index.html'), landing(published));
console.log('built /  (landing, ' + published.length + ' entries)');
console.log('site -> ' + OUT);
