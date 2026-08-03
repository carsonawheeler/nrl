import { readFile } from 'fs/promises';
import path from 'path';
import { getLeagueData } from '../lib/league';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The Claude Design export (design/nrl.dc.html) is a complete, self-contained
// DC document: an <x-dc> template plus a `class Component extends DCLogic` whose
// data fields (TEAMS, PLAYERS, …) were hardcoded from the design. We serve it
// nearly verbatim, injecting three things so the DB becomes the source of truth:
//   1. window.__DC_DATA__  — the DB-derived league bundle.
//   2. a subclass constructor that overrides the hardcoded fields with __DC_DATA__.
//   3. window.__resources   — points the runtime at our static TeamBadge + skips
//                             its self-refetch of the page.
// The runtime itself and the TeamBadge component are served statically from
// /public/dc. Presentation tokens (CONFS, MTYPE, RDLABEL, …) stay in the design.

const DATA_FIELDS = [
  'TEAMS', 'CHAMPS', 'RINGS', 'PLAYERS', 'COACHES',
  'S1PICKS', 'S2PICKS', 'S3PICKS', 'MOVES', 'RESULTS', 'STATS', 'STATTEAMS', 'FREEAGENTS',
  'BOXSCORES', 'AWARDS', 'PLAYOFF_ODDS',
  'COACHDIR', 'COACHSTATS', 'COACHFA',
];

// Runs after the design's field initializers, replacing the hardcoded data with
// whatever the server injected. Presentation/state fields are left untouched.
const CLASS_OPEN = 'class Component extends DCLogic {';
const OVERRIDE_CTOR =
  CLASS_OPEN +
  `\n  constructor(...a){ super(...a);\n` +
  `    const D = (typeof globalThis!=='undefined' && globalThis.__DC_DATA__) || null;\n` +
  `    if(D){ for(const k of ${JSON.stringify(DATA_FIELDS)}) if(D[k]!==undefined) this[k]=D[k]; }\n` +
  // notifs lives in this.state (not a class field). Replace the design's seeded
  // feed with the DB-injected one, applying the same localStorage seen-set so
  // only genuinely new items surface as unread.
  `    if(D && Array.isArray(D.NOTIFS) && this.state){\n` +
  `      let seen=[]; try{ seen=JSON.parse(localStorage.getItem('nrl_seen_notifs')||'[]'); }catch(e){}\n` +
  `      this.state.notifs = D.NOTIFS.map(n=>({id:n.id, type:n.type, time:n.time, title:n.title, body:n.body, unread: seen.includes(n.id) ? false : n.u}));\n` +
  `    }\n` +
  `  }`;

let templatePromise;
function loadTemplate() {
  templatePromise ||= readFile(path.join(process.cwd(), 'design', 'nrl.dc.html'), 'utf8');
  return templatePromise;
}

// Keep injected JSON safe inside a <script> element.
const jsonForScript = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

export async function GET() {
  const [raw, data] = await Promise.all([loadTemplate(), getLeagueData()]);

  const bootstrap =
    `<script>window.__DC_DATA__=${jsonForScript(data)};` +
    `window.__resources={"./TeamBadge.dc.html":"/dc/TeamBadge.dc.html"};</script>\n`;

  const html = raw
    // point at the statically-served runtime
    .replace('<script src="./support.js"></script>', '<script src="/dc/support.js"></script>')
    // rewrite the template's hardcoded design assets (assets/nrl.png,
    // assets/champN.png) to our public logo files. Team logos are data-driven
    // and already mapped in getLeagueData, so only these fixed crests remain.
    .replace(/src="assets\/nrl\.png"/g, 'src="/logos/nrl.webp"')
    .replace(/src="assets\/champ1\.png"/g, 'src="/logos/champ1.webp"')
    .replace(/src="assets\/champ2\.png"/g, 'src="/logos/champ2.webp"')
    .replace(/src="assets\/champ3\.png"/g, 'src="/logos/champ3.webp"')
    // inject the data-override constructor into the component class
    .replace(CLASS_OPEN, OVERRIDE_CTOR)
    // inject the data + resource map just before the component script
    .replace('<script type="text/x-dc" data-dc-script', bootstrap + '<script type="text/x-dc" data-dc-script');

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
