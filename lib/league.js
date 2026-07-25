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
  const [teamRows, standings, roster, pstats, coachRows, moveRows, board, games, seasonRows] =
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
      sql`SELECT p.name, se.number AS season, pss.is_playoff,
                 pss.games, pss.goals, pss.assists, pss.saves, pss.shots, pss.wins
          FROM player_season_stats pss
          JOIN players p  ON p.id = pss.player_id
          JOIN seasons se ON se.id = pss.season_id`,
      sql`SELECT DISTINCT ON (c.id) c.name, t.slug AS team, cs.role
          FROM coach_season_stats cs
          JOIN coaches c ON c.id = cs.coach_id
          JOIN teams t   ON t.id = cs.team_id
          WHERE NOT cs.is_playoff AND cs.role IS NOT NULL
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
      sql`SELECT se.number AS season, g.is_playoff, g.week, g.round, g.game_no,
                 ta.slug AS away, g.away_score, th.slug AS home, g.home_score
          FROM games g
          JOIN seasons se ON se.id = g.season_id
          LEFT JOIN teams ta ON ta.id = g.away_team_id
          LEFT JOIN teams th ON th.id = g.home_team_id
          ORDER BY se.number, g.is_playoff, g.week NULLS LAST, g.game_no NULLS LAST, g.id`,
      sql`SELECT number, logo FROM seasons ORDER BY number`,
    ]);

  // ---- TEAMS: brand tokens + per-season [w,l,t] records ----
  const recIndex = {}; // slug -> { 1:[w,l,t], 2:[w,l,t] }
  for (const r of standings) {
    (recIndex[r.slug] ||= {})[r.season] = [n(r.wins), n(r.losses), n(r.ties)];
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
    };
  });

  // ---- PLAYERS: current-roster snapshot ----
  const PLAYERS = roster.map((p) => {
    const o = { n: p.name, t: p.team, u: USER_KEY[p.user_name] || null, r: p.role, o: p.origin };
    if (p.status) o.st = p.status;
    if (p.awards && p.awards.length) o.aw = p.awards;
    return o;
  });

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

  // ---- RESULTS: latest season's games, shaped {id, rd, a, sa, b, sb, w} ----
  const seasonsWithGames = [...new Set(games.map((g) => g.season))];
  const curSeason = seasonsWithGames.length ? Math.max(...seasonsWithGames) : null;
  const RESULTS = [];
  for (const g of games) {
    if (g.season !== curSeason) continue;
    const rd = g.is_playoff ? PLAYOFF_ROUND_CODE[g.round] || g.round : `W${g.week}`;
    let w = 't';
    if (g.away_score != null && g.home_score != null) {
      w = g.away_score > g.home_score ? 'a' : g.home_score > g.away_score ? 'b' : 't';
    }
    RESULTS.push({
      id: `g${RESULTS.length + 1}`,
      rd,
      a: g.away,
      sa: g.away_score == null ? '' : String(g.away_score),
      b: g.home,
      sb: g.home_score == null ? '' : String(g.home_score),
      w,
    });
  }

  // ---- STATS: name -> { rs1, rs2, ps1, ps2 } = [gp, g, a, sv, sh, w] ----
  // Skip all-zero rows (e.g. empty Season 3 stat sheet) to match the design.
  const STATS = {};
  for (const r of pstats) {
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

  return { TEAMS, PLAYERS, COACHES, MOVES, S1PICKS, S2PICKS, S3PICKS, CHAMPS, RINGS, RESULTS, STATS };
}
