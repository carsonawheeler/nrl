-- National Rocket League — schema
-- Source of truth: per-season stat sheets + game scores. Aggregates are VIEWS.

DROP VIEW IF EXISTS v_career_coach_stats, v_career_stats, v_playoff_career_stats, v_standings CASCADE;
DROP TABLE IF EXISTS player_season_stats, coach_season_stats, games, draft_picks,
  draft_board, moves, free_agents, records, players, coaches, teams, seasons, users CASCADE;

CREATE TABLE users (
  id    serial PRIMARY KEY,
  name  text UNIQUE NOT NULL      -- 'Griffin', 'Nolan'
);

CREATE TABLE seasons (
  id      serial PRIMARY KEY,
  number  int UNIQUE NOT NULL,
  logo    text
);

CREATE TABLE teams (
  id          serial PRIMARY KEY,
  name        text UNIQUE NOT NULL,
  slug        text UNIQUE NOT NULL,
  conference  char(1),                -- 'F' / 'H'
  logo        text
);

CREATE TABLE players (
  id         serial PRIMARY KEY,
  name       text UNIQUE NOT NULL,
  user_id    int REFERENCES users(id),
  -- current-roster snapshot (source: design export; workbook has no roster metadata)
  team_id    int REFERENCES teams(id),
  role       char(1),               -- 'S' starter / 'B' backup
  origin     text,                  -- e.g. 'S1 Draft · Pick 1', 'Signed · Undrafted FA'
  status     text,                  -- 'inj' / 'out' / 'bench' / NULL
  awards     text[],                -- e.g. {'S1 MVP','S1 All-Star Starter'}
  on_roster  boolean NOT NULL DEFAULT false
);

CREATE TABLE coaches (
  id    serial PRIMARY KEY,
  name  text UNIQUE NOT NULL
);

-- role lives here, not on coaches: it changes season to season
CREATE TABLE coach_season_stats (
  id           serial PRIMARY KEY,
  coach_id     int NOT NULL REFERENCES coaches(id),
  season_id    int NOT NULL REFERENCES seasons(id),
  team_id      int REFERENCES teams(id),
  role         text,                  -- HC / OC / DC
  is_playoff   boolean NOT NULL DEFAULT false,
  score        numeric,
  wins         int, losses int, ties int,
  rings        int, series_wins int,
  UNIQUE (coach_id, season_id, is_playoff)
);

CREATE TABLE player_season_stats (
  id           serial PRIMARY KEY,
  player_id    int NOT NULL REFERENCES players(id),
  season_id    int NOT NULL REFERENCES seasons(id),
  team_id      int REFERENCES teams(id),
  is_playoff   boolean NOT NULL DEFAULT false,
  score        numeric,               -- NULL where sheet had #DIV/0!
  games int, goals int, assists int, saves int, shots int, wins int, rings int,
  awards       text,
  UNIQUE (player_id, season_id, is_playoff)
);

CREATE TABLE games (
  id          serial PRIMARY KEY,
  season_id   int NOT NULL REFERENCES seasons(id),
  is_playoff  boolean NOT NULL DEFAULT false,
  week        int,
  round       text,
  game_no     int,
  away_team_id int REFERENCES teams(id),
  away_score   int,
  away_seed    int,
  home_team_id int REFERENCES teams(id),
  home_score   int,
  home_seed    int
);

CREATE TABLE draft_picks (
  id            serial PRIMARY KEY,
  season_id     int NOT NULL REFERENCES seasons(id),
  player_name   text NOT NULL,
  griffin_stars numeric,
  nolan_stars   numeric,
  star_rating   numeric
);

CREATE TABLE free_agents (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  user_id     int REFERENCES users(id),
  star_rating numeric
);

CREATE TABLE records (
  id            serial PRIMARY KEY,
  scope         text,     -- 'REGULAR SEASON' / 'PLAYOFFS'
  category      text,     -- 'Career Records' / 'Single Season' ...
  label         text,
  player_name   text,
  user_name     text,
  team_name     text,
  amount        numeric,
  season_broken text,
  date_broken   text
);

-- Ordered draft board (source: design export). Distinct from draft_picks,
-- which holds the workbook's per-player star ratings.
CREATE TABLE draft_board (
  id          serial PRIMARY KEY,
  season_id   int NOT NULL REFERENCES seasons(id),
  pick_no     int NOT NULL,
  team_id     int REFERENCES teams(id),
  player_name text,                 -- NULL when the pick was forfeited
  owner       char(1),              -- 'G' Griffin / 'N' Nolan / 'F' forfeited
  UNIQUE (season_id, pick_no)
);

-- Roster moves / transactions (source: design export; no workbook sheet).
CREATE TABLE moves (
  id          text PRIMARY KEY,     -- 'm1'..'m9' from the design
  season_id   int REFERENCES seasons(id),
  phase       text,                 -- 'Season 2 · Draft Night'
  type        text NOT NULL,        -- trade / draft / sign / injury / lineup
  when_label  text,                 -- 'Week 4', 'Draft Night', 'Preseason'
  title       text NOT NULL,
  detail      text,
  team_a      int REFERENCES teams(id),
  team_b      int REFERENCES teams(id),
  picks_ref   text,                 -- 's1' / 's2' -> draft_board season, else NULL
  sort_order  int NOT NULL          -- preserves the design's ordering
);

CREATE INDEX ON player_season_stats (season_id, is_playoff);
CREATE INDEX ON coach_season_stats  (season_id, is_playoff);
CREATE INDEX ON games (season_id, is_playoff);

-- ---- derived views (replace the broken #REF! sheets) ----

CREATE VIEW v_career_stats AS
SELECT p.id AS player_id, p.name, u.name AS user_name,
       count(DISTINCT s.season_id)            AS seasons,
       sum(s.games) AS games, sum(s.goals) AS goals,
       sum(s.assists) AS assists, sum(s.saves) AS saves,
       sum(s.shots) AS shots, sum(s.wins) AS wins, sum(s.rings) AS rings
FROM players p
LEFT JOIN users u ON u.id = p.user_id
LEFT JOIN player_season_stats s ON s.player_id = p.id AND NOT s.is_playoff
GROUP BY p.id, p.name, u.name;

CREATE VIEW v_playoff_career_stats AS
SELECT p.id AS player_id, p.name, u.name AS user_name,
       count(DISTINCT s.season_id) AS seasons,
       sum(s.games) AS games, sum(s.goals) AS goals,
       sum(s.assists) AS assists, sum(s.saves) AS saves,
       sum(s.shots) AS shots, sum(s.wins) AS wins
FROM players p
LEFT JOIN users u ON u.id = p.user_id
JOIN player_season_stats s ON s.player_id = p.id AND s.is_playoff
GROUP BY p.id, p.name, u.name;

CREATE VIEW v_career_coach_stats AS
SELECT c.id AS coach_id, c.name,
       count(DISTINCT cs.season_id) AS seasons,
       sum(cs.wins) AS wins, sum(cs.losses) AS losses,
       sum(cs.ties) AS ties, sum(cs.rings) AS rings
FROM coaches c
LEFT JOIN coach_season_stats cs ON cs.coach_id = c.id AND NOT cs.is_playoff
GROUP BY c.id, c.name;

CREATE VIEW v_standings AS
WITH g AS (
  SELECT season_id, home_team_id AS team_id, home_score AS pf, away_score AS pa FROM games WHERE NOT is_playoff
  UNION ALL
  SELECT season_id, away_team_id, away_score, home_score FROM games WHERE NOT is_playoff
)
SELECT g.season_id, t.id AS team_id, t.name, t.conference,
       count(*) FILTER (WHERE pf > pa) AS wins,
       count(*) FILTER (WHERE pf < pa) AS losses,
       count(*) FILTER (WHERE pf = pa) AS ties,
       sum(pf) AS points_for, sum(pa) AS points_against
FROM g JOIN teams t ON t.id = g.team_id
GROUP BY g.season_id, t.id, t.name, t.conference;
