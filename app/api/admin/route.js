import { sql } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Admin write API. Every request must carry the shared admin password in the
// `x-admin-token` header, checked against ADMIN_PASSWORD (env only, never in
// code). Fails closed: if ADMIN_PASSWORD is unset, all requests are rejected.
// All writes use parameterized SQL so form input can never be interpolated as
// SQL. The main site renders with no-store, so saved rows appear on next load.

function checkAuth(req) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return { ok: false, code: 503, msg: 'Admin is not configured. Set ADMIN_PASSWORD in the environment.' };
  const token = req.headers.get('x-admin-token') || '';
  if (token !== pw) return { ok: false, code: 401, msg: 'Invalid admin password.' };
  return { ok: true };
}

const num = (v) => (v === '' || v == null ? null : Number(v));
const str = (v) => (v === '' || v == null ? null : String(v));
const bool = (v) => v === true || v === 'true' || v === 'on' || v === 1;
const json = (obj, status = 200) => Response.json(obj, { status });

// Reference lists that populate the form dropdowns.
export async function GET(req) {
  const a = checkAuth(req);
  if (!a.ok) return json({ error: a.msg }, a.code);
  const [teams, seasons, players, users] = await Promise.all([
    sql`SELECT id, name, slug, conference FROM teams ORDER BY name`,
    sql`SELECT id, number FROM seasons ORDER BY number`,
    sql`SELECT id, name FROM players ORDER BY name`,
    sql`SELECT id, name FROM users ORDER BY name`,
  ]);
  return json({ teams, seasons, players, users });
}

export async function POST(req) {
  const a = checkAuth(req);
  if (!a.ok) return json({ error: a.msg }, a.code);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Malformed request body.' }, 400);
  }
  const { action, data = {} } = body || {};

  try {
    switch (action) {
      case 'season': {
        const number = num(data.number);
        if (!number) return json({ error: 'Season number is required.' }, 400);
        const [row] = await sql`
          INSERT INTO seasons (number, logo) VALUES (${number}, ${str(data.logo)})
          RETURNING id, number`;
        return json({ ok: true, message: `Season ${row.number} added.`, row });
      }

      case 'team': {
        const name = str(data.name), slug = str(data.slug);
        if (!name || !slug) return json({ error: 'Team name and slug are required.' }, 400);
        const [row] = await sql`
          INSERT INTO teams (name, slug, conference, logo)
          VALUES (${name}, ${slug}, ${str(data.conference)}, ${str(data.logo)})
          RETURNING id, name`;
        return json({ ok: true, message: `Team ${row.name} added.`, row });
      }

      case 'player': {
        const name = str(data.name);
        if (!name) return json({ error: 'Player name is required.' }, 400);
        const awards = Array.isArray(data.awards)
          ? data.awards
          : (str(data.awards) ? String(data.awards).split(',').map((s) => s.trim()).filter(Boolean) : null);
        const [row] = await sql`
          INSERT INTO players (name, user_id, team_id, role, origin, status, awards, on_roster)
          VALUES (${name}, ${num(data.user_id)}, ${num(data.team_id)}, ${str(data.role)},
                  ${str(data.origin)}, ${str(data.status)}, ${awards && awards.length ? awards : null}, ${bool(data.on_roster)})
          RETURNING id, name`;
        return json({ ok: true, message: `Player ${row.name} added.`, row });
      }

      case 'playerStats': {
        const player_id = num(data.player_id), season_id = num(data.season_id);
        if (!player_id || !season_id) return json({ error: 'Player and season are required.' }, 400);
        const [row] = await sql`
          INSERT INTO player_season_stats
            (player_id, season_id, team_id, is_playoff, score, games, goals, assists, saves, shots, wins, rings, awards)
          VALUES
            (${player_id}, ${season_id}, ${num(data.team_id)}, ${bool(data.is_playoff)}, ${num(data.score)},
             ${num(data.games)}, ${num(data.goals)}, ${num(data.assists)}, ${num(data.saves)},
             ${num(data.shots)}, ${num(data.wins)}, ${num(data.rings)}, ${str(data.awards)})
          ON CONFLICT (player_id, season_id, is_playoff) DO UPDATE SET
            team_id = EXCLUDED.team_id, score = EXCLUDED.score, games = EXCLUDED.games,
            goals = EXCLUDED.goals, assists = EXCLUDED.assists, saves = EXCLUDED.saves,
            shots = EXCLUDED.shots, wins = EXCLUDED.wins, rings = EXCLUDED.rings, awards = EXCLUDED.awards
          RETURNING id`;
        return json({ ok: true, message: 'Stat line saved.', row });
      }

      case 'game': {
        const season_id = num(data.season_id);
        if (!season_id) return json({ error: 'Season is required.' }, 400);
        if (!num(data.away_team_id) || !num(data.home_team_id))
          return json({ error: 'Both teams are required.' }, 400);
        const [row] = await sql`
          INSERT INTO games
            (season_id, is_playoff, week, round, game_no, away_team_id, away_score, away_seed, home_team_id, home_score, home_seed)
          VALUES
            (${season_id}, ${bool(data.is_playoff)}, ${num(data.week)}, ${str(data.round)}, ${num(data.game_no)},
             ${num(data.away_team_id)}, ${num(data.away_score)}, ${num(data.away_seed)},
             ${num(data.home_team_id)}, ${num(data.home_score)}, ${num(data.home_seed)})
          RETURNING id`;
        return json({ ok: true, message: `Game #${row.id} added.`, row });
      }

      case 'draftPick': {
        const season_id = num(data.season_id), pick_no = num(data.pick_no);
        if (!season_id || !pick_no) return json({ error: 'Season and pick number are required.' }, 400);
        const [row] = await sql`
          INSERT INTO draft_board (season_id, pick_no, team_id, player_name, owner)
          VALUES (${season_id}, ${pick_no}, ${num(data.team_id)}, ${str(data.player_name)}, ${str(data.owner)})
          ON CONFLICT (season_id, pick_no) DO UPDATE SET
            team_id = EXCLUDED.team_id, player_name = EXCLUDED.player_name, owner = EXCLUDED.owner
          RETURNING id`;
        return json({ ok: true, message: `Pick #${pick_no} saved.`, row });
      }

      case 'move': {
        const type = str(data.type), title = str(data.title);
        if (!type || !title) return json({ error: 'Move type and title are required.' }, 400);
        const ids = await sql`SELECT id FROM moves`;
        const maxNum = ids.reduce((m, r) => {
          const n = parseInt(String(r.id).replace(/\D/g, ''), 10);
          return isNaN(n) ? m : Math.max(m, n);
        }, 0);
        const [{ min_sort }] = await sql`SELECT COALESCE(MIN(sort_order), 0) AS min_sort FROM moves`;
        const newId = 'm' + (maxNum + 1);
        const sortOrder = (Number(min_sort) || 0) - 1; // newest moves sort to the top
        const [row] = await sql`
          INSERT INTO moves
            (id, season_id, phase, type, when_label, title, detail, team_a, team_b, picks_ref, sort_order)
          VALUES
            (${newId}, ${num(data.season_id)}, ${str(data.phase)}, ${type}, ${str(data.when_label)},
             ${title}, ${str(data.detail)}, ${num(data.team_a)}, ${num(data.team_b)}, ${str(data.picks_ref)}, ${sortOrder})
          RETURNING id`;
        return json({ ok: true, message: `Move ${row.id} added.`, row });
      }

      case 'freeAgent': {
        const name = str(data.name);
        if (!name) return json({ error: 'Free agent name is required.' }, 400);
        const [row] = await sql`
          INSERT INTO free_agents (name, user_id, star_rating)
          VALUES (${name}, ${num(data.user_id)}, ${num(data.star_rating)})
          RETURNING id, name`;
        return json({ ok: true, message: `Free agent ${row.name} added.`, row });
      }

      default:
        return json({ error: 'Unknown action: ' + action }, 400);
    }
  } catch (e) {
    return json({ error: e.message || 'Database error.' }, 400);
  }
}
