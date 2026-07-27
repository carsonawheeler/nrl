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
  const [teamRows, standings, roster, pstats, coachRows, moveRows, board, games, seasonRows, faRows, notifRows] =
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
                 ta.slug AS away, g.away_score, th.slug AS home, g.home_score
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
    const margin = g.away_score - g.home_score;
    (diffIndex[g.away] ||= {})[g.season] = (diffIndex[g.away][g.season] || 0) + margin;
    (diffIndex[g.home] ||= {})[g.season] = (diffIndex[g.home][g.season] || 0) - margin;
    (pfIndex[g.away] ||= {})[g.season] = (pfIndex[g.away][g.season] || 0) + g.away_score;
    (pfIndex[g.home] ||= {})[g.season] = (pfIndex[g.home][g.season] || 0) + g.home_score;
    if (g.away_score !== g.home_score) {
      const [w, l] = g.away_score > g.home_score ? [g.away, g.home] : [g.home, g.away];
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
    let w = '';
    if (played) w = g.away_score > g.home_score ? 'a' : g.home_score > g.away_score ? 'b' : 't';
    RESULTS.push({
      id: `g${g.id}`,
      s: String(g.season),
      playoff: g.is_playoff,
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

  return { TEAMS, PLAYERS, COACHES, MOVES, S1PICKS, S2PICKS, S3PICKS, CHAMPS, RINGS, RESULTS, STATS, STATTEAMS, FREEAGENTS, NOTIFS };
}
