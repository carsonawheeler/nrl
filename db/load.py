#!/usr/bin/env python3
"""Load National Rocket League.xlsx into Postgres.

Usage:  python db/load.py path/to/National_Rocket_League.xlsx
Requires: pip install openpyxl psycopg2-binary
Reads DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL from env.
"""
import os, re, sys, openpyxl, psycopg2

XLSX = sys.argv[1] if len(sys.argv) > 1 else "National_Rocket_League.xlsx"
DSN  = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ["DATABASE_URL"]

CONF = {  # conference assignment
 "Surge":"F","Coyotes":"F","Frogs":"F","Guardians":"F","Barracudas":"F",
 "Vortex":"H","Scorpions":"H","Goats":"H","Turtles":"H","Vipers":"H",
}

def clean(v):
    """Normalize a cell: strip whitespace, drop Excel errors and em-dash placeholders."""
    if v is None: return None
    s = str(v).strip()
    if not s or s.startswith("#") or s in ("——","--","—"): return None
    return s

def num(v):
    s = clean(v)
    if s is None: return None
    try: return float(s)
    except ValueError: return None

def inum(v):
    f = num(v)
    return int(f) if f is not None else None

def score(v):
    """Parse a game-score cell. Nulls Excel errors, and folds OT/shootout
    notation like '11+1' into a single total (12)."""
    s = clean(v)
    if s is None: return None
    if "+" in s:
        try: return int(sum(float(x) for x in s.split("+")))
        except ValueError: return None
    return inum(s)

def slug(name):
    return re.sub(r"[^a-z0-9]+","-", name.lower()).strip("-")

SEED_RE = re.compile(r"^#(\d+)\s+(.*)$")
def split_seed(v):
    """'#3 Frogs' -> (3, 'Frogs');  'Frogs' -> (None, 'Frogs').
    Note: does NOT run clean() first — clean() drops '#'-prefixed values,
    which would nuke every seeded playoff team name."""
    if v is None: return None, None
    s = str(v).strip()
    if not s or s in ("——", "--", "—"): return None, None
    m = SEED_RE.match(s)
    if m: return int(m.group(1)), m.group(2).strip()
    return (None, None) if s.startswith("#") else (None, s)

wb = openpyxl.load_workbook(XLSX, data_only=True)
cx = psycopg2.connect(DSN); cur = cx.cursor()

def one(q, *a):
    cur.execute(q, a); r = cur.fetchone(); return r[0] if r else None

# ---- dimensions -------------------------------------------------------
users, teams, players, coaches, seasons = {}, {}, {}, {}, {}

def user_id(n):
    n = clean(n)
    if not n: return None
    if n not in users:
        users[n] = one("INSERT INTO users(name) VALUES(%s) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id", n)
    return users[n]

def team_id(n):
    n = clean(n)
    if not n: return None
    if n not in teams:
        teams[n] = one("""INSERT INTO teams(name,slug,conference,logo) VALUES(%s,%s,%s,%s)
                          ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id""",
                       n, slug(n), CONF.get(n), f"/logos/{slug(n)}.webp")
    return teams[n]

def player_id(n, u=None):
    n = clean(n)
    if not n: return None
    if n not in players:
        players[n] = one("""INSERT INTO players(name,user_id) VALUES(%s,%s)
                            ON CONFLICT(name) DO UPDATE SET user_id=COALESCE(players.user_id,EXCLUDED.user_id)
                            RETURNING id""", n, user_id(u))
    return players[n]

def coach_id(n):
    n = clean(n)
    if not n: return None
    if n not in coaches:
        coaches[n] = one("INSERT INTO coaches(name) VALUES(%s) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id", n)
    return coaches[n]

def season_id(num_):
    k = int(num_)
    if k not in seasons:
        seasons[k] = one("""INSERT INTO seasons(number,logo) VALUES(%s,%s)
                            ON CONFLICT(number) DO UPDATE SET number=EXCLUDED.number RETURNING id""",
                         k, f"/logos/champ{k}.webp")
    return seasons[k]

for s in (1,2,3): season_id(s)

# ---- player season stats ---------------------------------------------
def load_players(sheet, season, playoff):
    if sheet not in wb.sheetnames: return 0
    n = 0
    for r in wb[sheet].iter_rows(min_row=2, values_only=True):
        name = clean(r[0])
        if not name: continue
        cur.execute("""INSERT INTO player_season_stats
            (player_id,season_id,team_id,is_playoff,score,games,goals,assists,saves,shots,wins)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (player_id,season_id,is_playoff) DO NOTHING""",
            (player_id(name, r[1]), season_id(season), team_id(r[2]), playoff,
             num(r[3]), inum(r[4]), inum(r[5]), inum(r[6]), inum(r[7]), inum(r[8]), inum(r[9])))
        n += 1
    return n

# ---- coach season stats ----------------------------------------------
def load_coaches(sheet, season, playoff):
    if sheet not in wb.sheetnames: return 0
    n = 0
    for r in wb[sheet].iter_rows(min_row=2, values_only=True):
        name = clean(r[0])
        if not name: continue
        cur.execute("""INSERT INTO coach_season_stats
            (coach_id,season_id,team_id,role,is_playoff,score,wins,losses,ties,rings,series_wins)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (coach_id,season_id,is_playoff) DO NOTHING""",
            (coach_id(name), season_id(season), team_id(r[2]), clean(r[1]), playoff,
             num(r[3]), inum(r[4]), inum(r[5]), inum(r[6]), inum(r[7]),
             inum(r[8]) if playoff else None))
        n += 1
    return n

tot_p = tot_c = 0
for s in (1,2,3):
    tot_p += load_players(f"Season {s} Stat Sheet", s, False)
    tot_p += load_players(f"Season {s} Playoff Stat Sheet", s, True)
    tot_c += load_coaches(f"Season {s} Coach Stat Sheet", s, False)
    tot_c += load_coaches(f"Season {s} Playoff Coach Stat She", s, True)

# ---- games ------------------------------------------------------------
# These fact tables have no natural key, so re-running would duplicate rows.
# Clear them first to keep the loader idempotent (dimensions/stats above use
# ON CONFLICT and are safe to re-run).
cur.execute("TRUNCATE games, draft_picks, free_agents, records RESTART IDENTITY")

g = 0
for r in wb["Regular Season Game Scores All-"].iter_rows(min_row=2, values_only=True):
    if not clean(r[0]): continue
    cur.execute("""INSERT INTO games(season_id,is_playoff,week,away_team_id,away_score,home_team_id,home_score)
                   VALUES(%s,false,%s,%s,%s,%s,%s)""",
        (season_id(num(r[0])), inum(r[1]), team_id(r[2]), score(r[3]), team_id(r[4]), score(r[5])))
    g += 1

for r in wb["Playoff Game Scores All-Time"].iter_rows(min_row=2, values_only=True):
    if not clean(r[0]): continue
    aseed, aname = split_seed(r[3])
    hseed, hname = split_seed(r[5])
    cur.execute("""INSERT INTO games(season_id,is_playoff,round,game_no,
                     away_team_id,away_score,away_seed,home_team_id,home_score,home_seed)
                   VALUES(%s,true,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (season_id(num(r[0])), clean(r[1]), inum(r[2]),
         team_id(aname), score(r[4]), aseed, team_id(hname), score(r[6]), hseed))
    g += 1

# ---- draft classes & free agents --------------------------------------
d = 0
for s in (2,3):
    sh = f"Season {s} Draft Class"
    if sh not in wb.sheetnames: continue
    for r in wb[sh].iter_rows(min_row=2, values_only=True):
        if not clean(r[0]): continue
        cur.execute("""INSERT INTO draft_picks(season_id,player_name,griffin_stars,nolan_stars,star_rating)
                       VALUES(%s,%s,%s,%s,%s)""",
            (season_id(s), clean(r[0]), num(r[2]), num(r[3]), num(r[4])))
        d += 1

fa = 0
for r in wb["Free Agents"].iter_rows(min_row=2, values_only=True):
    if not clean(r[0]): continue
    stars = clean(r[2])
    cur.execute("INSERT INTO free_agents(name,user_id,star_rating) VALUES(%s,%s,%s)",
                (clean(r[0]), user_id(r[1]), float(stars.count("⭐")) if stars else None))
    fa += 1

# ---- record book (section headers become scope/category) --------------
rec = 0; scope = cat = None
for r in wb["Record Book"].iter_rows(min_row=2, values_only=True):
    a = clean(r[0])
    if not a: continue
    if a in ("REGULAR SEASON","PLAYOFFS"): scope = a; continue
    if not clean(r[1]): cat = a; continue
    cur.execute("""INSERT INTO records(scope,category,label,player_name,user_name,team_name,amount,season_broken,date_broken)
                   VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (scope, cat, a, clean(r[1]), clean(r[2]), clean(r[3]), num(r[4]), clean(r[5]), clean(r[6])))
    rec += 1

cx.commit()
print(f"users={len(users)} teams={len(teams)} players={len(players)} coaches={len(coaches)}")
print(f"player_rows={tot_p} coach_rows={tot_c} games={g} draft={d} free_agents={fa} records={rec}")
cur.close(); cx.close()
