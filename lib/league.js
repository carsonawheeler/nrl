import { sql } from './db';
import { TEAM_BRAND, USER_KEY, PLAYOFF_ROUND_CODE } from './design-tokens';

// Neon returns aggregate/bigint columns as strings; coerce to numbers.
const n = (v) => (v == null ? 0 : Number(v));

// Assembles the design's data fields straight from Postgres, shaped exactly as
// the DC Component expects (TEAMS, PLAYERS, COACHES, MOVES, S1PICKS/S2PICKS,
// CHAMPS, RINGS, RESULTS, STATS). Pure presentation maps (CONFS, MTYPE, NTYPE,
// ROLELABEL, RDLABEL, RDSHORT, notifs) stay in the design and are not sourced
// here. Team branding (abbr/conf/color/nickname/mono) comes from design-tokens;
// league data (records, rosters, results, champions) is DB-derived.
export async function getLeagueData() {
  const [teamRows, standings, roster, pstats, coachRows, moveRows, board, games, seasonRows, faRows, notifRows, gpstats, coachStatRows, coachFaRows] =
    await Promise.all([
      sql`SELECT id, slug, name, logo FROM teams ORDER BY slug`,
      sql`SELECT se.number AS season, t.slug, vs.wins, vs.losses, vs.ties
          FROM v_standings vs
          JOIN teams t   ON t.id = vs.team_id
          JOIN seasons se ON se.id = vs.season_id`,
      sql`SELECT p.name, t.slug AS team, u.name AS user_name,
                 p.role, p.origin, p.status, p.awards
          FROM players p
          JOIN teams t   ON t.id = p.team_id
          LEFT JOIN users u ON u.id = p.user_id
          WHERE p.on_roster
          ORDER BY t.slug, p.role, p.name`,
      sql`SELECT p.name, se.number AS season, pss.is_playoff, pt.slug AS team,
                 pss.games, pss.goals, pss.assists, pss.saves, pss.shots, pss.wins
          FROM player_season_stats pss
          JOIN players p  ON p.id = pss.player_id
          JOIN seasons se ON se.id = pss.season_id
          LEFT JOIN teams pt ON pt.id = pss.team_id`,
      sql`SELECT DISTINCT ON (c.id) c.name, t.slug AS team, cs.role
          FROM coach_season_stats cs
          JOIN coaches c ON c.id = cs.coach_id
          JOIN teams t   ON t.id = cs.team_id
          WHERE NOT cs.is_playoff AND cs.role IS NOT NULL
            AND cs.season_id = (SELECT max(season_id) FROM coach_season_stats WHERE NOT is_playoff)
          ORDER BY c.id, cs.season_id DESC`,
      sql`SELECT m.id, se.number AS season, m.phase, m.type, m.when_label,
                 m.title, m.detail, ta.slug AS team_a, tb.slug AS team_b, m.picks_ref
          FROM moves m
          LEFT JOIN seasons se ON se.id = m.season_id
          LEFT JOIN teams ta ON ta.id = m.team_a
          LEFT JOIN teams tb ON tb.id = m.team_b
          ORDER BY m.sort_order`,
      sql`SELECT se.number AS season, db.pick_no, t.slug, db.player_name, db.owner
          FROM draft_board db
          JOIN seasons se ON se.id = db.season_id
          LEFT JOIN teams t ON t.id = db.team_id
          ORDER BY se.number, db.pick_no`,
      sql`SELECT g.id, se.number AS season, g.is_playoff, g.week, g.round, g.game_no,
                 ta.slug AS away, g.away_score, g.away_bonus, th.slug AS home, g.home_score, g.home_bonus
          FROM games g
          JOIN seasons se ON se.id = g.season_id
          LEFT JOIN teams ta ON ta.id = g.away_team_id
          LEFT JOIN teams th ON th.id = g.home_team_id
          ORDER BY se.number, g.is_playoff, g.week NULLS LAST, g.game_no NULLS LAST, g.id`,
      sql`SELECT number, logo FROM seasons ORDER BY number`,
      // Free agents: cut players carry a controlling user (and a last team we
      // resolve from their most recent season sheet); the undrafted pool carries
      // a star rating instead. The two are split into categories client-side.
      sql`SELECT fa.name, u.name AS user_name, fa.star_rating,
                 p.role, p.origin, p.awards,
                 (SELECT th.slug FROM player_season_stats pss
                  JOIN teams th ON th.id = pss.team_id
                  WHERE pss.player_id = p.id
                  ORDER BY pss.season_id DESC LIMIT 1) AS last_team
          FROM free_agents fa
          LEFT JOIN users u   ON u.id = fa.user_id
          LEFT JOIN players p ON p.name = fa.name
          ORDER BY fa.star_rating DESC NULLS LAST, fa.name`,
      // News feed: newest first. Rendered as the design's notifs; unread state is
      // computed client-side from a localStorage seen-set keyed by the id below.
      sql`SELECT id, type, time_label, title, body FROM notifications
          ORDER BY created_at DESC, id DESC LIMIT 30`,
      // Per-game player box scores. Drives the game screen's box-score lineups
      // and the live award race (aggregated per player for the current season).
      sql`SELECT gps.game_id, t.slug AS team, p.name, p.role, u.name AS user_name,
                 gps.goals, gps.assists, gps.saves, gps.shots
          FROM game_player_stats gps
          JOIN players p  ON p.id = gps.player_id
          LEFT JOIN teams t ON t.id = gps.team_id
          LEFT JOIN users u ON u.id = p.user_id
          ORDER BY gps.game_id, t.slug, gps.goals DESC, p.name`,
      // Full coach season history (every coach, every season, reg + playoff rows).
      // Assembled below into season-by-season + career stats and award accolades.
      sql`SELECT c.name, se.number AS season, t.slug AS team, cs.role, cs.is_playoff,
                 cs.wins, cs.losses, cs.ties, cs.series_wins, cs.rings
          FROM coach_season_stats cs
          JOIN coaches c ON c.id = cs.coach_id
          JOIN seasons se ON se.id = cs.season_id
          LEFT JOIN teams t ON t.id = cs.team_id
          ORDER BY c.name, se.number, cs.is_playoff`,
      // Admin-managed coach free-agent pool (cut coaches + undrafted prospects).
      sql`SELECT name, star_rating FROM coach_free_agents ORDER BY star_rating DESC NULLS LAST, name`,
    ]);

  // ---- TEAMS: brand tokens + per-season [w,l,t] records ----
  const recIndex = {}; // slug -> { 1:[w,l,t], 2:[w,l,t] }
  for (const r of standings) {
    (recIndex[r.slug] ||= {})[r.season] = [n(r.wins), n(r.losses), n(r.ties)];
  }
  // Per-season goal differential (goals for − goals against) from played
  // regular-season games — mirrors the win/loss records above, which are also
  // regular-season only, so the standings' DIFF column stays consistent.
  const diffIndex = {}; // slug -> { season: diff }
  // Total points scored (goals for) and head-to-head records per team/season —
  // the standings tie-breaker order is record → head-to-head → point
  // differential → total points, so the sort needs all three beyond win/loss.
  const pfIndex = {};  // slug -> { season: pointsFor }
  const h2hIndex = {}; // slug -> { season: { otherSlug: wins - losses } }
  for (const g of games) {
    if (g.is_playoff || g.away_score == null || g.home_score == null) continue;
    // Differential and total points use base scores only — bonus (tiebreak)
    // points decide the winner but never inflate the margin or points-for.
    const margin = g.away_score - g.home_score;
    (diffIndex[g.away] ||= {})[g.season] = (diffIndex[g.away][g.season] || 0) + margin;
    (diffIndex[g.home] ||= {})[g.season] = (diffIndex[g.home][g.season] || 0) - margin;
    (pfIndex[g.away] ||= {})[g.season] = (pfIndex[g.away][g.season] || 0) + g.away_score;
    (pfIndex[g.home] ||= {})[g.season] = (pfIndex[g.home][g.season] || 0) + g.home_score;
    // Winner (incl. head-to-head) is decided by score + bonus, so a tied score
    // with a bonus point still records a win/loss rather than a tie.
    const awayTot = g.away_score + (g.away_bonus || 0), homeTot = g.home_score + (g.home_bonus || 0);
    if (awayTot !== homeTot) {
      const [w, l] = awayTot > homeTot ? [g.away, g.home] : [g.home, g.away];
      ((h2hIndex[w] ||= {})[g.season] ||= {})[l] = (h2hIndex[w][g.season][l] || 0) + 1;
      ((h2hIndex[l] ||= {})[g.season] ||= {})[w] = (h2hIndex[l][g.season][w] || 0) - 1;
    }
  }
  const TEAMS = teamRows.map((t) => {
    const brand = TEAM_BRAND[t.slug] || {};
    return {
      id: t.slug,
      name: t.name,
      abbr: brand.abbr || t.slug.slice(0, 3).toUpperCase(),
      conf: brand.conf || null,
      c: brand.c || '#5f758f',
      mono: !!brand.mono,
      // Mono teams render as a text badge (design authored logo:''); this also
      // sidesteps teams that have no logo asset. Others use the DB logo path.
      logo: brand.mono ? '' : t.logo || '',
      tag: brand.tag || '',
      s1: recIndex[t.slug]?.[1] || [0, 0, 0],
      s2: recIndex[t.slug]?.[2] || [0, 0, 0],
      s3: recIndex[t.slug]?.[3] || [0, 0, 0],
      d1: diffIndex[t.slug]?.[1] || 0,
      d2: diffIndex[t.slug]?.[2] || 0,
      d3: diffIndex[t.slug]?.[3] || 0,
      pf1: pfIndex[t.slug]?.[1] || 0,
      pf2: pfIndex[t.slug]?.[2] || 0,
      pf3: pfIndex[t.slug]?.[3] || 0,
      h2h: h2hIndex[t.slug] || {},
    };
  });

  // ---- PLAYERS: current-roster snapshot ----
  const PLAYERS = roster.map((p) => {
    const o = { n: p.name, t: p.team, u: USER_KEY[p.user_name] || null, r: p.role, o: p.origin };
    if (p.status) o.st = p.status;
    if (p.awards && p.awards.length) o.aw = p.awards;
    return o;
  });

  // ---- Auto-lineup on injury ----
  // Each team fields one starter per manager; when that starter is sidelined
  // ('inj'/'out'), the same manager's healthy backup is automatically promoted
  // so the effective starting lineup (roster view, game lineups) stays filled.
  // Driven entirely by the DB status field — no hardcoded names — so it applies
  // to any current or future injury. The injured player keeps their status flag.
  const SIDELINED = new Set(['inj', 'out']);
  const byTeamMgr = {}; // 'team|user' -> [players]
  for (const p of PLAYERS) (byTeamMgr[p.t + '|' + p.u] ||= []).push(p);
  for (const group of Object.values(byTeamMgr)) {
    const injuredStarter = group.find((p) => p.r === 'S' && SIDELINED.has(p.st));
    if (!injuredStarter) continue;
    const backup = group.find((p) => p.r === 'B' && !SIDELINED.has(p.st));
    if (!backup) continue;
    injuredStarter.r = 'B';
    backup.r = 'S';
  }

  // ---- COACHES ----
  const COACHES = coachRows.map((c) => ({ n: c.name, t: c.team, role: c.role }));

  // ---- MOVES ----
  const MOVES = moveRows.map((m) => {
    const o = {
      id: m.id,
      s: String(m.season),
      phase: m.phase,
      type: m.type,
      when: m.when_label,
      title: m.title,
      detail: m.detail,
    };
    if (m.team_a) o.a = m.team_a;
    if (m.team_b) o.b = m.team_b;
    if (m.picks_ref) o.picks = m.picks_ref;
    return o;
  });

  // ---- S1PICKS / S2PICKS / S3PICKS: [pick_no, slug, name, owner] ----
  // Each season's draft board is bucketed by season so picks never leak across
  // the per-season "Draft" move cards.
  const S1PICKS = [];
  const S2PICKS = [];
  const S3PICKS = [];
  for (const p of board) {
    const row = [p.pick_no, p.slug, p.player_name || '—', p.owner];
    if (p.season === 1) S1PICKS.push(row);
    else if (p.season === 2) S2PICKS.push(row);
    else if (p.season === 3) S3PICKS.push(row);
  }

  // ---- RESULTS: every season's games, shaped {id, s, playoff, rd, a, sa, b, sb, w}.
  // The Scores screen filters this by season via its dropdown. Unplayed games
  // (no scores yet, e.g. an upcoming season's schedule) carry empty scores and
  // w='' so they render as fixtures rather than 0-0 ties. IDs use the DB game id
  // so they stay unique across seasons (needed for box-score navigation).
  const RESULTS = [];
  for (const g of games) {
    const rd = g.is_playoff ? PLAYOFF_ROUND_CODE[g.round] || g.round : `W${g.week}`;
    const played = g.away_score != null && g.home_score != null;
    // Bonus points break a tied score to decide the winner. They render as a
    // "+N" suffix (e.g. "9+1") but don't change the base score shown.
    const awayTot = played ? g.away_score + (g.away_bonus || 0) : 0;
    const homeTot = played ? g.home_score + (g.home_bonus || 0) : 0;
    let w = '';
    if (played) w = awayTot > homeTot ? 'a' : homeTot > awayTot ? 'b' : 't';
    const disp = (score, bonus) => score == null ? '' : (bonus ? `${score}+${bonus}` : String(score));
    RESULTS.push({
      id: `g${g.id}`,
      s: String(g.season),
      playoff: g.is_playoff,
      rd,
      a: g.away,
      sa: disp(g.away_score, g.away_bonus),
      b: g.home,
      sb: disp(g.home_score, g.home_bonus),
      w,
    });
  }

  // ---- STATS: name -> { rs1, rs2, ps1, ps2 } = [gp, g, a, sv, sh, w] ----
  // Skip all-zero rows (e.g. empty Season 3 stat sheet) to match the design.
  const STATS = {};
  // name -> { seasonNumber: slug }: the team the player played for that season,
  // so the per-season stats view can badge them by their team at the time.
  const STATTEAMS = {};
  for (const r of pstats) {
    if (r.team) (STATTEAMS[r.name] ||= {})[r.season] = r.team;
    const line = [n(r.games), n(r.goals), n(r.assists), n(r.saves), n(r.shots), n(r.wins)];
    if (line.every((v) => v === 0)) continue;
    const key = (r.is_playoff ? 'ps' : 'rs') + r.season;
    (STATS[r.name] ||= {})[key] = line;
  }

  // ---- CHAMPS / RINGS: champion = most finals-game wins that season ----
  const finalsWins = {}; // season -> slug -> wins
  for (const g of games) {
    if (!g.is_playoff || PLAYOFF_ROUND_CODE[g.round] !== 'F') continue;
    if (g.away_score == null || g.home_score == null) continue;
    const winner = g.away_score > g.home_score ? g.away : g.home;
    (finalsWins[g.season] ||= {})[winner] = (finalsWins[g.season]?.[winner] || 0) + 1;
  }
  const ROMAN = { 1: 'I', 2: 'II', 3: 'III' };
  const CHAMPS = seasonRows.map((s) => {
    const wins = finalsWins[s.number] || {};
    const champ = Object.entries(wins).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return { s: ROMAN[s.number] || String(s.number), label: `SEASON ${s.number}`, logo: s.logo || '', champ };
  });
  const RINGS = {};
  for (const c of CHAMPS) if (c.champ) RINGS[c.champ] = (RINGS[c.champ] || 0) + 1;

  // ---- FREEAGENTS: split into 'cut' (was rostered, has a manager + last team)
  // and 'available' (never played, carries a star rating) ----
  const FREEAGENTS = { cut: [], available: [] };
  for (const f of faRows) {
    if (f.user_name) {
      FREEAGENTS.cut.push({
        n: f.name,
        u: USER_KEY[f.user_name] || null,
        t: f.last_team || null,
        r: f.role || null,
        o: f.origin || null,
        aw: f.awards || [],
      });
    } else {
      FREEAGENTS.available.push({ n: f.name, stars: n(f.star_rating), r: f.role || null, o: f.origin || null });
    }
  }

  // ---- COACHES (full): season-by-season + career stats + award accolades ----
  // Group every coach's rows by season into { reg, po } (regular + playoff row).
  const coachSeasons = {}; // name -> season -> { season, team, role, reg, po }
  for (const r of coachStatRows) {
    const c = (coachSeasons[r.name] ||= {});
    const s = (c[r.season] ||= { season: r.season, team: null, role: null, reg: null, po: null });
    if (r.is_playoff) s.po = r; else s.reg = r;
    if (r.team) s.team = r.team;
    if (r.role) s.role = r.role;
  }
  // Which side of the ball an award belongs to. TMOY/SOY are offensive production,
  // DPOY defensive; MVP/ROY/All-Star are whole-player honors shared by all coaches.
  const AWARD_SIDE = { DPOY: 'def', TMOY: 'off', SOY: 'off', MVP: 'all', ROY: 'all' };
  const awardSideOf = (type) => (type.startsWith('All-Star') ? 'all' : (AWARD_SIDE[type] || 'all'));
  // Index every player award by season -> team -> [{award, player, type, side}],
  // resolving the winner's team that season from STATTEAMS. Dedupe by name+award.
  const awardHolders = [
    ...roster.map((p) => ({ nm: p.name, aw: p.awards })),
    ...faRows.map((f) => ({ nm: f.name, aw: f.awards })),
  ];
  const playerAwardIdx = {}; // season -> team -> [awards]
  const seenAw = new Set();
  for (const h of awardHolders) {
    if (!h.aw || !h.aw.length) continue;
    for (const award of h.aw) {
      const k = h.nm + '|' + award;
      if (seenAw.has(k)) continue;
      seenAw.add(k);
      const m = /^S(\d+)\s+(.+)$/.exec(award);
      if (!m) continue;
      const sNum = Number(m[1]);
      const type = m[2].trim();
      const team = (STATTEAMS[h.nm] || {})[sNum];
      if (!team) continue;
      ((playerAwardIdx[sNum] ||= {})[team] ||= []).push({ award, player: h.nm, type, side: awardSideOf(type) });
    }
  }
  // A coach sees an award if HC (all), or their side matches (OC=off, DC=def),
  // or it's a neutral/whole-player award.
  const roleSeesSide = (role, side) =>
    role === 'HC' || side === 'all' || (role === 'OC' && side === 'off') || (role === 'DC' && side === 'def');
  const COACHSTATS = {};
  for (const [name, seasonsObj] of Object.entries(coachSeasons)) {
    const seasonsArr = Object.values(seasonsObj).sort((a, b) => a.season - b.season);
    const career = { w: 0, l: 0, t: 0, apps: 0, poW: 0, poL: 0, sw: 0, sl: 0, rings: 0 };
    const rows = [];
    const playerAwards = [];
    for (const s of seasonsArr) {
      const reg = s.reg || {};
      // Regular-season record is the team's actual standing that season (the
      // authoritative, game-derived source shared by all coaches on the team) —
      // the coach_season_stats reg row is a stale seed for the live season.
      const standRec = (recIndex[s.team] || {})[s.season];
      const w = standRec ? standRec[0] : n(reg.wins);
      const l = standRec ? standRec[1] : n(reg.losses);
      const t = standRec ? standRec[2] : n(reg.ties);
      career.w += w; career.l += l; career.t += t;
      let po = null;
      if (s.po) {
        const rings = n(s.po.rings);
        // No series_losses column: a playoff run ends in exactly one series loss
        // unless it wins the ring (rings>0 => 0 losses that run).
        const sl = rings > 0 ? 0 : 1;
        po = { w: n(s.po.wins), l: n(s.po.losses), sw: n(s.po.series_wins), sl, rings };
        career.apps += 1; career.poW += po.w; career.poL += po.l;
        career.sw += po.sw; career.sl += sl; career.rings += rings;
      }
      rows.push({ s: s.season, team: s.team, role: s.role, w, l, t, po });
      const aws = ((playerAwardIdx[s.season] || {})[s.team]) || [];
      for (const a of aws) if (roleSeesSide(s.role, a.side)) playerAwards.push({ ...a, season: s.season, team: s.team });
    }
    const latest = seasonsArr[seasonsArr.length - 1];
    COACHSTATS[name] = {
      n: name,
      curTeam: latest ? latest.team : null,
      curRole: latest ? latest.role : null,
      rows: rows.reverse(),
      career,
      personalAwards: [],
      playerAwards,
    };
  }
  // ---- COACHFA: split free-agent coaches into 'cut' (has history) vs
  // 'available' (never coached, carries a star rating) ----
  const coachFaNames = new Set();
  const COACHFA = { cut: [], available: [] };
  for (const f of coachFaRows) {
    coachFaNames.add(f.name);
    const cs = COACHSTATS[f.name];
    if (cs && cs.rows.length) COACHFA.cut.push({ n: f.name, t: cs.curTeam || null, role: cs.curRole || null });
    else COACHFA.available.push({ n: f.name, stars: n(f.star_rating) });
  }
  // ---- COACHDIR: directory list. Active coaches badged by current team; free
  // agents floated to the bottom. Sorted by team then role (HC/OC/DC). ----
  const curSeasonNum = Math.max(...seasonRows.map((s) => s.number));
  const roleOrder = { HC: 0, OC: 1, DC: 2 };
  const COACHDIR = [];
  for (const [name, cs] of Object.entries(COACHSTATS)) {
    const isFa = coachFaNames.has(name);
    const active = !isFa && cs.rows.length && cs.rows[0].s === curSeasonNum && cs.rows[0].team;
    COACHDIR.push({ n: name, t: active ? cs.curTeam : null, role: cs.curRole || null, fa: isFa });
  }
  for (const f of COACHFA.available) COACHDIR.push({ n: f.n, t: null, role: null, fa: true });
  COACHDIR.sort((a, b) => {
    if (a.fa !== b.fa) return a.fa ? 1 : -1;
    const ta = a.t || '~', tb = b.t || '~';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9);
  });

  // ---- NOTIFS: DB-backed news feed. `id` is a stable string so the client can
  // track which items have been seen; `u:true` primes them as unread until the
  // seen-set (localStorage) says otherwise. Presentation (tag/color/tint) is
  // applied at render from the design's NTYPE map keyed by `type`.
  const NOTIFS = notifRows.map((r) => ({
    id: 'db' + r.id,
    type: r.type,
    time: r.time_label,
    title: r.title,
    body: r.body,
    u: true,
  }));

  // ---- BOXSCORES: per-game player lines, keyed to match RESULTS ids ('g'+id).
  // Shape: { 'g70': { guardians:[{n,t,u,r,g,a,sv,sh}], vortex:[...] } }. Players
  // carry the same fields decPlayer expects (n/t/u/r) plus their stat line.
  const gameById = {};
  for (const g of games) gameById[g.id] = g;
  const BOXSCORES = {};
  for (const r of gpstats) {
    const key = 'g' + r.game_id;
    (BOXSCORES[key] ||= {});
    (BOXSCORES[key][r.team] ||= []).push({
      n: r.name, t: r.team, u: USER_KEY[r.user_name] || null, r: r.role,
      g: n(r.goals), a: n(r.assists), sv: n(r.saves), sh: n(r.shots),
    });
  }

  // ---- AWARDS: live award race for the current (latest played) regular season.
  // Season totals are aggregated straight from the box scores so they always
  // match the games just entered, independent of player_season_stats refreshes.
  const currentSeason = Math.max(
    0,
    ...games.filter((g) => !g.is_playoff && g.away_score != null).map((g) => g.season)
  );
  const agg = {}; // name -> { n, t, u, gp, g, a, sv, sh, w }
  for (const r of gpstats) {
    const gm = gameById[r.game_id];
    if (!gm || gm.is_playoff || gm.season !== currentSeason) continue;
    if (gm.away_score == null || gm.home_score == null) continue;
    const p = (agg[r.name] ||= { n: r.name, t: r.team, u: USER_KEY[r.user_name] || null, gp: 0, g: 0, a: 0, sv: 0, sh: 0, w: 0 });
    p.gp += 1; p.g += n(r.goals); p.a += n(r.assists); p.sv += n(r.saves); p.sh += n(r.shots);
    const teamIsAway = gm.away === r.team;
    const teamScore = teamIsAway ? gm.away_score : gm.home_score;
    const oppScore = teamIsAway ? gm.home_score : gm.away_score;
    if (teamScore > oppScore) p.w += 1;
  }
  // A player is a rookie in the current season if they logged no season stats in
  // any earlier season (veteran detection uses the historical season sheets).
  const playedBefore = new Set();
  for (const r of pstats) if (r.season < currentSeason) playedBefore.add(r.name);
  // Better team record (current season): more wins, then higher win%.
  const recScore = (slug) => {
    const [w, l, t] = recIndex[slug]?.[currentSeason] || [0, 0, 0];
    const gp = w + l + t;
    return { w, pct: gp ? (w + 0.5 * t) / gp : 0 };
  };
  const cmpRec = (sa, sb) => {
    const A = recScore(sa), B = recScore(sb);
    return B.w - A.w || B.pct - A.pct;
  };
  const players = Object.values(agg).filter((p) => p.gp > 0);
  // Games the player's team played this season (regular season).
  const teamGp = (slug) => {
    const [w, l, t] = recIndex[slug]?.[currentSeason] || [0, 0, 0];
    return w + l + t;
  };
  // MVP/ROY: standard weighted score, minus 3 for every team game the player did
  // not start in (participation penalty), all divided by games played.
  const mvpVal = (p) => {
    const notStarted = Math.max(0, teamGp(p.t) - p.gp);
    return (2 * p.g + 0.5 * p.a + 0.5 * p.sv + 0.1 * p.sh + p.w - 3 * notStarted) / p.gp;
  };
  // Rank every candidate for an award (full ordered list). The home screen shows
  // the top 5 (via .slice); the award-race screen shows all of them.
  const rank = (arr, valFn, dispFn) =>
    arr
      .map((p) => ({ p, v: valFn(p) }))
      .sort((x, y) => y.v - x.v || cmpRec(x.p.t, y.p.t) || y.p.gp - x.p.gp)
      .map((o, i) => ({ rank: i + 1, n: o.p.n, t: o.p.t, u: o.p.u, gp: o.p.gp, val: o.v, disp: dispFn(o.v) }));
  // DPOY/TMOY/SOY are per-game rates. Divide by the team's games played (not the
  // player's) so a player who sat out games can't top the race on a tiny sample —
  // missed games count as zero production (availability penalty).
  const availGp = (p) => Math.max(p.gp, teamGp(p.t));
  const fullRaces = {
    mvp: rank(players, mvpVal, (v) => v.toFixed(2)),
    dpoy: rank(players, (p) => p.sv / availGp(p), (v) => v.toFixed(1)),
    tmoy: rank(players, (p) => p.a / availGp(p), (v) => v.toFixed(1)),
    soy: rank(players, (p) => p.sh / availGp(p), (v) => v.toFixed(1)),
    roy: rank(players.filter((p) => !playedBefore.has(p.n)), mvpVal, (v) => v.toFixed(2)),
  };
  const AWARDS = {
    season: currentSeason,
    mvp: fullRaces.mvp.slice(0, 5),
    dpoy: fullRaces.dpoy.slice(0, 5),
    tmoy: fullRaces.tmoy.slice(0, 5),
    soy: fullRaces.soy.slice(0, 5),
    roy: fullRaces.roy.slice(0, 5),
    full: fullRaces,
  };

  // ---- PLAYOFF_ODDS: each team's chance of reaching the playoffs (top 3 per
  // conference). We project the current season's remaining regular-season games:
  // with few left we enumerate every outcome exactly, with many we fall back to a
  // seeded Monte Carlo so the numbers stay stable between requests. A game's
  // win probability is a logistic function of the two teams' per-game scoring
  // margin, shrunk toward neutral for small samples. Final standings within each
  // scenario use the same tie-breakers as the standings screen (wins → win% →
  // head-to-head → point differential → total points).
  const PLAYOFF_SPOTS = 3; // berths per conference
  const ODDS_SCALE = 2.5; // logistic scale on the per-game margin gap
  const ODDS_SHRINK = 3; // games of regression toward a neutral margin
  const confOf = {};
  for (const t of TEAMS) confOf[t.id] = t.conf;
  const cs = currentSeason;
  const teamsAll = Object.keys(confOf);
  const baseW = {}, baseL = {}, baseT = {}, remCount = {}, strength = {};
  for (const slug of teamsAll) {
    const [w, l, t] = recIndex[slug]?.[cs] || [0, 0, 0];
    baseW[slug] = w; baseL[slug] = l; baseT[slug] = t; remCount[slug] = 0;
    strength[slug] = (diffIndex[slug]?.[cs] || 0) / (w + l + t + ODDS_SHRINK);
  }
  const rem = games.filter((g) => g.season === cs && !g.is_playoff && g.away_score == null && g.away && g.home);
  for (const g of rem) { remCount[g.away] += 1; remCount[g.home] += 1; }
  const pAway = rem.map((g) => 1 / (1 + Math.exp(-(strength[g.away] - strength[g.home]) / ODDS_SCALE)));

  const oddsSum = {}; for (const s of teamsAll) oddsSum[s] = 0;
  let totalW = 0;
  const tallyScenario = (winnerAway, weight) => {
    const wAdd = {}, h2hAdd = {};
    for (let i = 0; i < rem.length; i++) {
      const g = rem[i], awayWon = winnerAway[i];
      const winner = awayWon ? g.away : g.home;
      wAdd[winner] = (wAdd[winner] || 0) + 1;
      (h2hAdd[g.away] ||= {})[g.home] = (h2hAdd[g.away][g.home] || 0) + (awayWon ? 1 : -1);
      (h2hAdd[g.home] ||= {})[g.away] = (h2hAdd[g.home][g.away] || 0) + (awayWon ? -1 : 1);
    }
    const finalW = {}, pctv = {};
    for (const s of teamsAll) {
      const w = baseW[s] + (wAdd[s] || 0);
      const gp = baseW[s] + baseL[s] + baseT[s] + remCount[s];
      finalW[s] = w;
      pctv[s] = gp ? (w + 0.5 * baseT[s]) / gp : 0;
    }
    const h2hMargin = (x, y) => (h2hIndex[x]?.[cs]?.[y] || 0) + (h2hAdd[x]?.[y] || 0);
    for (const cf of ['F', 'H']) {
      const arr = teamsAll.filter((s) => confOf[s] === cf).sort((x, y) =>
        (finalW[y] - finalW[x])
        || (pctv[y] - pctv[x])
        || -h2hMargin(x, y)
        || ((diffIndex[y]?.[cs] || 0) - (diffIndex[x]?.[cs] || 0))
        || ((pfIndex[y]?.[cs] || 0) - (pfIndex[x]?.[cs] || 0)));
      for (let i = 0; i < PLAYOFF_SPOTS && i < arr.length; i++) oddsSum[arr[i]] += weight;
    }
    totalW += weight;
  };

  const R = rem.length;
  const seasonPlayed = games.some((g) => g.season === cs && !g.is_playoff && g.away_score != null);
  if (seasonPlayed && teamsAll.length) {
    if (R === 0) {
      tallyScenario([], 1); // regular season complete — standings are final
    } else if (R <= 16) {
      const winnerAway = new Array(R); // exact: weight every 2^R outcome by its probability
      for (let mask = 0; mask < (1 << R); mask++) {
        let weight = 1;
        for (let i = 0; i < R; i++) { const away = (mask >> i) & 1; winnerAway[i] = !!away; weight *= away ? pAway[i] : 1 - pAway[i]; }
        tallyScenario(winnerAway, weight);
      }
    } else {
      let seed = (0x9e3779b9 ^ R) >>> 0; // seeded Monte Carlo — deterministic across requests
      const rng = () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
      const winnerAway = new Array(R);
      for (let it = 0; it < 20000; it++) { for (let i = 0; i < R; i++) winnerAway[i] = rng() < pAway[i]; tallyScenario(winnerAway, 1); }
    }
  }
  const PLAYOFF_ODDS = {
    season: cs,
    spots: PLAYOFF_SPOTS,
    teams: totalW > 0 ? teamsAll.map((s) => ({ t: s, pct: (oddsSum[s] / totalW) * 100 })) : [],
  };

  return { TEAMS, PLAYERS, COACHES, MOVES, S1PICKS, S2PICKS, S3PICKS, CHAMPS, RINGS, RESULTS, STATS, STATTEAMS, FREEAGENTS, NOTIFS, BOXSCORES, AWARDS, PLAYOFF_ODDS, COACHDIR, COACHSTATS, COACHFA };
}
