# National Rocket League

League site for the NRL. Next.js on Vercel, Postgres on Neon.

## Setup

Env vars are injected by the Vercel–Neon integration:
- `DATABASE_URL` — pooled, for app queries
- `DATABASE_URL_UNPOOLED` — direct, for migrations and bulk loads

## Database

Apply the schema (once):

    psql "$DATABASE_URL_UNPOOLED" -f db/schema.sql

Load the workbook:

    pip install openpyxl psycopg2-binary
    python db/load.py path/to/National_Rocket_League.xlsx

The loader is idempotent for dimensions (users/teams/players/coaches/seasons)
and skips duplicate season-stat rows, so it is safe to re-run.

### Design notes

- Per-season sheets are the source of truth. Career/rank sheets in the
  workbook are **derived** and are rebuilt here as SQL views
  (`v_career_stats`, `v_playoff_career_stats`, `v_career_coach_stats`,
  `v_standings`). The workbook's `Career Coach Stats` was full of `#REF!`;
  the view replaces it.
- Coach `role` (HC/OC/DC) lives on `coach_season_stats`, not `coaches` —
  roles change between seasons.
- Loader normalizes trailing-space team names, nulls `#DIV/0!` scores,
  and splits playoff seeds (`#3 Frogs` -> seed 3, team Frogs).

## Local dev

    npm install
    npm run dev
