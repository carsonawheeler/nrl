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
const int0 = (v) => (v === '' || v == null || isNaN(Number(v)) ? 0 : Math.trunc(Number(v)));
const str = (v) => (v === '' || v == null ? null : String(v));
const bool = (v) => v === true || v === 'true' || v === 'on' || v === 1;
const json = (obj, status = 200) => Response.json(obj, { status });

// Insert a news/notifications row. Newest rows sort to the top of the feed.
async function postNews({ type = 'news', time_label = null, title, body = null }) {
  if (!title) return null;
  const [row] = await sql`
    INSERT INTO notifications (type, time_label, title, body)
    VALUES (${type}, ${str(time_label)}, ${title}, ${str(body)})
    RETURNING id`;
  return row;
}

// Insert a moves-feed row with an auto-generated id and a sort_order that keeps
// the newest move at the top (mirrors the legacy `move` action's numbering).
async function postMove({ season_id = null, phase = null, type, when_label = null, title, detail = null, team_a = null, team_b = null, picks_ref = null }) {
  if (!type || !title) return null;
  const ids = await sql`SELECT id FROM moves`;
  const maxNum = ids.reduce((m, r) => {
    const nn = parseInt(String(r.id).replace(/\D/g, ''), 10);
    return isNaN(nn) ? m : Math.max(m, nn);
  }, 0);
  const [{ min_sort }] = await sql`SELECT COALESCE(MIN(sort_order), 0) AS min_sort FROM moves`;
  const newId = 'm' + (maxNum + 1);
  const sortOrder = (Number(min_sort) || 0) - 1;
  const [row] = await sql`
    INSERT INTO moves
      (id, season_id, phase, type, when_label, title, detail, team_a, team_b, picks_ref, sort_order)
    VALUES
      (${newId}, ${season_id}, ${phase}, ${type}, ${when_label},
       ${title}, ${detail}, ${team_a}, ${team_b}, ${picks_ref}, ${sortOrder})
    RETURNING id`;
  return row;
}

// Recompute player_season_stats (games/goals/assists/saves/shots/wins + the
// team they finished the season on) straight from the game_player_stats box
// scores, for a set of players in one (season, is_playoff) bucket. Score, rings,
// and awards are intentionally left untouched — those stay manually curated.
// Career totals are a live view over player_season_stats, so they follow along.
async function recompute(playerIds, season_id, is_playoff) {
  if (!playerIds || !playerIds.length) return;
  await sql`
    INSERT INTO player_season_stats
      (player_id, season_id, is_playoff, team_id, games, goals, assists, saves, shots, wins)
    SELECT gps.player_id, g.season_id, g.is_playoff,
           (array_agg(gps.team_id ORDER BY g.week DESC NULLS LAST, g.id DESC))[1] AS team_id,
           count(DISTINCT gps.game_id) AS games,
           sum(gps.goals) AS goals, sum(gps.assists) AS assists,
           sum(gps.saves) AS saves, sum(gps.shots) AS shots,
           count(*) FILTER (
             WHERE (gps.team_id = g.home_team_id AND g.home_score > g.away_score)
                OR (gps.team_id = g.away_team_id AND g.away_score > g.home_score)
           ) AS wins
    FROM game_player_stats gps
    JOIN games g ON g.id = gps.game_id
    WHERE gps.player_id = ANY(${playerIds})
      AND g.season_id = ${season_id} AND g.is_playoff = ${is_playoff}
    GROUP BY gps.player_id, g.season_id, g.is_playoff
    ON CONFLICT (player_id, season_id, is_playoff) DO UPDATE SET
      team_id = EXCLUDED.team_id, games = EXCLUDED.games, goals = EXCLUDED.goals,
      assists = EXCLUDED.assists, saves = EXCLUDED.saves, shots = EXCLUDED.shots,
      wins = EXCLUDED.wins`;
  // Any affected player who no longer has a box line this bucket (removed from
  // the game) gets their box-derived columns zeroed. Score/rings/awards are left
  // intact; an all-zero stat line is dropped from the STATS view at render.
  await sql`
    UPDATE player_season_stats pss
    SET games = 0, goals = 0, assists = 0, saves = 0, shots = 0, wins = 0
    WHERE pss.season_id = ${season_id} AND pss.is_playoff = ${is_playoff}
      AND pss.player_id = ANY(${playerIds})
      AND NOT EXISTS (
        SELECT 1 FROM game_player_stats gps JOIN games g ON g.id = gps.game_id
        WHERE gps.player_id = pss.player_id
          AND g.season_id = ${season_id} AND g.is_playoff = ${is_playoff})`;
}

// Reference lists that populate the form dropdowns and edit pickers.
export async function GET(req) {
  const a = checkAuth(req);
  if (!a.ok) return json({ error: a.msg }, a.code);

  // `?box=<game_id>` returns a single game's saved box score lines so the admin
  // UI can load and edit them without wiping the roster on re-save.
  const boxId = num(new URL(req.url).searchParams.get('box'));
  if (boxId) {
    const rows = await sql`
      SELECT gps.player_id, gps.team_id, gps.goals, gps.assists, gps.saves, gps.shots, p.name
      FROM game_player_stats gps JOIN players p ON p.id = gps.player_id
      WHERE gps.game_id = ${boxId} ORDER BY p.name`;
    return json({ box: rows });
  }

  const [teams, seasons, players, users, games, moves, freeAgents] = await Promise.all([
    sql`SELECT id, name, slug, conference FROM teams ORDER BY name`,
    sql`SELECT id, number FROM seasons ORDER BY number`,
    sql`SELECT p.id, p.name, p.team_id, p.role, p.origin, p.status, p.awards, p.on_roster,
               t.slug AS team_slug
        FROM players p LEFT JOIN teams t ON t.id = p.team_id
        ORDER BY p.name`,
    sql`SELECT id, name FROM users ORDER BY name`,
    sql`SELECT g.id, se.number AS season, g.is_playoff, g.week, g.round, g.game_no,
               g.away_team_id, g.away_score, g.away_seed,
               g.home_team_id, g.home_score, g.home_seed,
               ta.slug AS away, th.slug AS home
        FROM games g
        JOIN seasons se ON se.id = g.season_id
        LEFT JOIN teams ta ON ta.id = g.away_team_id
        LEFT JOIN teams th ON th.id = g.home_team_id
        ORDER BY se.number DESC, g.is_playoff, g.week NULLS LAST, g.game_no NULLS LAST, g.id`,
    sql`SELECT m.id, m.season_id, se.number AS season, m.phase, m.type, m.when_label, m.title, m.detail,
               m.team_a, m.team_b, m.picks_ref
        FROM moves m LEFT JOIN seasons se ON se.id = m.season_id
        ORDER BY m.sort_order`,
    sql`SELECT id, name, user_id, star_rating FROM free_agents ORDER BY name`,
  ]);
  return json({ teams, seasons, players, users, games, moves, freeAgents });
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
        await postNews({ type: 'news', time_label: `Season ${row.number}`, title: `Season ${row.number} is live`, body: `The Season ${row.number} schedule is now on the board.` });
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

      // Edit an existing player's roster info and awards (the STATS/roster views
      // read these). Only fields present in the payload are changed.
      case 'editPlayer': {
        const id = num(data.id);
        if (!id) return json({ error: 'Player id is required.' }, 400);
        const awards = Array.isArray(data.awards)
          ? data.awards
          : (str(data.awards) ? String(data.awards).split(',').map((s) => s.trim()).filter(Boolean) : null);
        const [row] = await sql`
          UPDATE players SET
            team_id = ${num(data.team_id)}, role = ${str(data.role)},
            origin = ${str(data.origin)}, status = ${str(data.status)},
            awards = ${awards && awards.length ? awards : null},
            on_roster = ${bool(data.on_roster)}
          WHERE id = ${id}
          RETURNING id, name`;
        if (!row) return json({ error: 'Player not found.' }, 404);
        return json({ ok: true, message: `Player ${row.name} updated.`, row });
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

      // Create (or update) a game together with each player's box score, then
      // recompute the affected players' season+career stats and post a result to
      // the news feed. This is the box-score-driven path the admin UI uses.
      case 'gameWithBox': {
        const season_id = num(data.season_id);
        const away_team_id = num(data.away_team_id), home_team_id = num(data.home_team_id);
        if (!season_id) return json({ error: 'Season is required.' }, 400);
        if (!away_team_id || !home_team_id) return json({ error: 'Both teams are required.' }, 400);
        const is_playoff = bool(data.is_playoff);
        const box = Array.isArray(data.box) ? data.box.filter((b) => num(b.player_id)) : [];

        let game_id = num(data.game_id);
        if (game_id) {
          const [row] = await sql`
            UPDATE games SET
              season_id = ${season_id}, is_playoff = ${is_playoff}, week = ${num(data.week)},
              round = ${str(data.round)}, game_no = ${num(data.game_no)},
              away_team_id = ${away_team_id}, away_score = ${num(data.away_score)}, away_seed = ${num(data.away_seed)},
              home_team_id = ${home_team_id}, home_score = ${num(data.home_score)}, home_seed = ${num(data.home_seed)}
            WHERE id = ${game_id} RETURNING id`;
          if (!row) return json({ error: 'Game not found.' }, 404);
        } else {
          const [row] = await sql`
            INSERT INTO games
              (season_id, is_playoff, week, round, game_no, away_team_id, away_score, away_seed, home_team_id, home_score, home_seed)
            VALUES
              (${season_id}, ${is_playoff}, ${num(data.week)}, ${str(data.round)}, ${num(data.game_no)},
               ${away_team_id}, ${num(data.away_score)}, ${num(data.away_seed)},
               ${home_team_id}, ${num(data.home_score)}, ${num(data.home_seed)})
            RETURNING id`;
          game_id = row.id;
        }

        // Players whose totals may change: everyone in the new box, plus anyone
        // previously on this game's box score (so removals get recomputed too).
        const prior = await sql`SELECT player_id FROM game_player_stats WHERE game_id = ${game_id}`;
        const affected = new Set(prior.map((r) => Number(r.player_id)));
        await sql`DELETE FROM game_player_stats WHERE game_id = ${game_id}`;
        for (const b of box) {
          const pid = num(b.player_id);
          affected.add(pid);
          await sql`
            INSERT INTO game_player_stats (game_id, player_id, team_id, goals, assists, saves, shots)
            VALUES (${game_id}, ${pid}, ${num(b.team_id)}, ${int0(b.goals)}, ${int0(b.assists)}, ${int0(b.saves)}, ${int0(b.shots)})`;
        }
        await recompute([...affected], season_id, is_playoff);

        // Post a result to the news feed when both scores are present.
        const as = num(data.away_score), hs = num(data.home_score);
        if (as != null && hs != null) {
          const [tt] = await sql`
            SELECT (SELECT name FROM teams WHERE id = ${away_team_id}) AS away,
                   (SELECT name FROM teams WHERE id = ${home_team_id}) AS home`;
          const [{ number: snum }] = await sql`SELECT number FROM seasons WHERE id = ${season_id}`;
          const winner = as > hs ? tt.away : hs > as ? tt.home : null;
          const title = winner
            ? `${winner} win ${Math.max(as, hs)}-${Math.min(as, hs)}`
            : `${tt.away} and ${tt.home} draw ${as}-${hs}`;
          const label = is_playoff ? `S${snum} · Playoffs` : `S${snum} · Wk ${int0(data.week) || '?'}`;
          await postNews({ type: 'result', time_label: label, title, body: `${tt.away} ${as}, ${tt.home} ${hs}.` });
        }
        return json({ ok: true, message: `Game #${game_id} saved (${box.length} box lines).`, row: { id: game_id } });
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

      // Add a whole draft class at once: upsert every pick for the season, then
      // announce it in both the news feed and the moves feed.
      case 'draftClass': {
        const season_id = num(data.season_id);
        if (!season_id) return json({ error: 'Season is required.' }, 400);
        const picks = Array.isArray(data.picks) ? data.picks.filter((p) => num(p.pick_no)) : [];
        if (!picks.length) return json({ error: 'At least one pick is required.' }, 400);
        for (const p of picks) {
          await sql`
            INSERT INTO draft_board (season_id, pick_no, team_id, player_name, owner)
            VALUES (${season_id}, ${num(p.pick_no)}, ${num(p.team_id)}, ${str(p.player_name)}, ${str(p.owner)})
            ON CONFLICT (season_id, pick_no) DO UPDATE SET
              team_id = EXCLUDED.team_id, player_name = EXCLUDED.player_name, owner = EXCLUDED.owner`;
        }
        const [{ number: snum }] = await sql`SELECT number FROM seasons WHERE id = ${season_id}`;
        await postMove({ season_id, phase: 'Preseason', type: 'draft', when_label: 'Draft', title: `Season ${snum} Draft`, detail: `${picks.length} picks are in the books.`, picks_ref: `S${snum}` });
        await postNews({ type: 'news', time_label: 'Preseason', title: `Season ${snum} Draft complete`, body: `${picks.length} picks are on the board.` });
        return json({ ok: true, message: `Draft class saved (${picks.length} picks).` });
      }

      case 'move': {
        const type = str(data.type), title = str(data.title);
        if (!type || !title) return json({ error: 'Move type and title are required.' }, 400);
        const row = await postMove({
          season_id: num(data.season_id), phase: str(data.phase), type, when_label: str(data.when_label),
          title, detail: str(data.detail), team_a: num(data.team_a), team_b: num(data.team_b), picks_ref: str(data.picks_ref),
        });
        // Roster/transaction moves also surface in the news feed.
        await postNews({ type: 'roster', time_label: str(data.when_label), title, body: str(data.detail) });
        return json({ ok: true, message: `Move ${row.id} added.`, row });
      }

      // Edit an existing move card in place (a correction, so no re-announce).
      case 'editMove': {
        const id = str(data.id);
        if (!id) return json({ error: 'Move id is required.' }, 400);
        const [row] = await sql`
          UPDATE moves SET
            season_id = ${num(data.season_id)}, phase = ${str(data.phase)}, type = ${str(data.type)},
            when_label = ${str(data.when_label)}, title = ${str(data.title)}, detail = ${str(data.detail)},
            team_a = ${num(data.team_a)}, team_b = ${num(data.team_b)}, picks_ref = ${str(data.picks_ref)}
          WHERE id = ${id} RETURNING id`;
        if (!row) return json({ error: 'Move not found.' }, 404);
        return json({ ok: true, message: `Move ${row.id} updated.`, row });
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

      // Edit an existing free agent (manager, star rating).
      case 'editFreeAgent': {
        const id = num(data.id);
        if (!id) return json({ error: 'Free agent id is required.' }, 400);
        const [row] = await sql`
          UPDATE free_agents SET user_id = ${num(data.user_id)}, star_rating = ${num(data.star_rating)}
          WHERE id = ${id} RETURNING id, name`;
        if (!row) return json({ error: 'Free agent not found.' }, 404);
        return json({ ok: true, message: `Free agent ${row.name} updated.`, row });
      }

      default:
        return json({ error: 'Unknown action: ' + action }, 400);
    }
  } catch (e) {
    return json({ error: e.message || 'Database error.' }, 400);
  }
}
