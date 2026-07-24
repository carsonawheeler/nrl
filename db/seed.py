#!/usr/bin/env python3
"""Seed design-sourced content into Postgres.

The workbook is the source of truth for stats, standings, games, and coaches.
But the app also needs curated metadata that never existed in the workbook:
current-roster info (starter/backup, origin, injury status, awards), the ordered
draft board, and roster moves. That data comes from the Claude Design export and
is transcribed here.

Run AFTER db/load.py (it relies on teams/seasons/users already existing).
Idempotent: players are upserted; draft_board and moves are replaced.

Usage:  python db/seed.py
Reads DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL from env.
"""
import os, psycopg2

DSN = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ["DATABASE_URL"]

# name, team slug, user (G/N), role (S/B), origin, status, awards
ROSTER = [
    ("Barry Cuda","barracudas","G","S","S1 Draft · Pick 1",None,["S1 All-Star Reserve"]),
    ("Cody Coconut","barracudas","G","B","S2 Draft · Pick 12",None,None),
    ("Perry Penguin","barracudas","N","S","S2 Draft · Pick 2",None,None),
    ("Finn Diesel","barracudas","N","B","S1 Draft · Pick 16",None,None),
    ("Wiley Coyote","coyotes","G","S","S1 Draft · Pick 15",None,["S1 DPOY","S1 All-Star Reserve"]),
    ("Cactus Carl","coyotes","G","B","S2 Draft · Pick 14",None,None),
    ("Bacon McSizzle","coyotes","N","S","S2 Draft · Pick 3",None,None),
    ("Dizzy Spin","coyotes","N","B","Acquired · Trade (VTX)",None,None),
    ("Tad Pole","frogs","G","S","S1 Draft · Pick 3",None,["S1 MVP","S1 All-Star Starter"]),
    ("Quack Johnson","frogs","G","B","S2 Draft · Pick 15",None,None),
    ("Toast Malone","frogs","N","S","S2 Draft · Pick 5","inj",None),
    ("Jeremiah Bullfrog","frogs","N","B","S1 Draft · Pick 10",None,None),
    ("Billy Gruff","goats","G","S","S1 Draft · Pick 17",None,["S1 TMOY"]),
    ("Colby Cheddar","goats","G","B","S2 Draft · Pick 17",None,None),
    ("Horny Hank","goats","N","S","S1 Draft · Pick 2","out",["S1 All-Star Starter"]),
    ("Larry Lobster","goats","N","B","S2 Draft · Pick 7",None,None),
    ("Brick Wall Bill","guardians","G","S","S1 Draft · Pick 5",None,["S1 All-Star Starter"]),
    ("Rocky Balboulder","guardians","G","B","S2 Draft · Pick 19",None,None),
    ("Brock Boulder","guardians","N","S","S2 Draft · Pick 9",None,None),
    ("Sir Blocksalot","guardians","N","B","S1 Draft · Pick 8","bench",None),
    ("Gary Gumball","scorpions","G","S","S2 Draft · Pick 6",None,None),
    ("Pinchy Pete","scorpions","G","B","S1 Draft · Pick 7",None,None),
    ("Scorpio Jones","scorpions","N","S","S1 Draft · Pick 14",None,["S1 All-Star Starter"]),
    ("Benny Bagel","scorpions","N","B","S2 Draft · Pick 16",None,None),
    ("Bolt McLightning","surge","G","S","S1 Draft · Pick 11",None,["S1 All-Star Reserve"]),
    ("Marty Moose","surge","G","B","S2 Draft · Pick 18",None,None),
    ("Watt Zapper","surge","N","S","S1 Draft · Pick 20","inj",None),
    ("Cornelius Cobb","surge","N","B","S2 Draft · Pick 8",None,None),
    ("Sheldon Shelby","turtles","G","S","S1 Draft · Pick 19",None,["S1 All-Star Starter"]),
    ("Carter Cone","turtles","G","B","S2 Draft · Pick 20",None,None),
    ("Turbo Turtle","turtles","N","S","S1 Draft · Pick 6",None,None),
    ("Parker Pickles","turtles","N","B","S2 Draft · Pick 10",None,None),
    ("Ricky Raccoon","vipers","G","S","S2 Draft · Pick 4",None,None),
    ("Donnie Dough","vipers","G","B","Signed · Undrafted FA",None,None),
    ("Wally Waffles","vipers","N","S","S2 Draft · Pick 1",None,None),
    ("Fang McBite","vipers","N","B","S1 Draft · Pick 12",None,None),
    ("Tornado Tim","vortex","G","S","S1 Draft · Pick 9",None,None),
    ("Snakey Jake","vortex","G","B","Acquired · Trade (VPR)",None,None),
    ("Dusty Paws","vortex","N","S","Acquired · Trade (COY)",None,["S1 All-Star Starter"]),
    ("Pretzel Preston","vortex","N","B","S2 Draft · Pick 11",None,None),
]

# season, [ (pick_no, team slug, player_name|None, owner G/N/F) ... ]
DRAFT_BOARD = {
    1: [
        (1,"barracudas","Barry Cuda","G"),(2,"goats","Horny Hank","N"),(3,"frogs","Tad Pole","G"),(4,"coyotes","Dusty Paws","N"),
        (5,"guardians","Brick Wall Bill","G"),(6,"turtles","Turbo Turtle","N"),(7,"scorpions","Pinchy Pete","G"),(8,"guardians","Sir Blocksalot","N"),
        (9,"vortex","Tornado Tim","G"),(10,"frogs","Jeremiah Bullfrog","N"),(11,"surge","Bolt McLightning","G"),(12,"vipers","Fang McBite","N"),
        (13,"vipers","Snakey Jake","G"),(14,"scorpions","Scorpio Jones","N"),(15,"coyotes","Wiley Coyote","G"),(16,"barracudas","Finn Diesel","N"),
        (17,"goats","Billy Gruff","G"),(18,"vortex","Dizzy Spin","N"),(19,"turtles","Sheldon Shelby","G"),(20,"surge","Watt Zapper","N"),
    ],
    2: [
        (1,"vipers","Wally Waffles","N"),(2,"barracudas","Perry Penguin","N"),(3,"coyotes","Bacon McSizzle","N"),(4,"vipers","Ricky Raccoon","G"),
        (5,"frogs","Toast Malone","N"),(6,"scorpions","Gary Gumball","G"),(7,"goats","Larry Lobster","N"),(8,"surge","Cornelius Cobb","N"),
        (9,"guardians","Brock Boulder","N"),(10,"turtles","Parker Pickles","N"),(11,"vortex","Pretzel Preston","N"),(12,"barracudas","Cody Coconut","G"),
        (13,"vortex",None,"F"),(14,"coyotes","Cactus Carl","G"),(15,"frogs","Quack Johnson","G"),(16,"scorpions","Benny Bagel","N"),
        (17,"goats","Colby Cheddar","G"),(18,"surge","Marty Moose","G"),(19,"guardians","Rocky Balboulder","G"),(20,"turtles","Carter Cone","G"),
    ],
}

# id, season, phase, type, when_label, title, detail, team_a, team_b, picks_ref
MOVES = [
    ("m1",2,"Season 2 · In-Season","injury","Week 4","Watt Zapper — Engine Failure",
     "Surge starter (Nolan) is sidelined for 3 games with an engine failure.","surge",None,None),
    ("m2",2,"Season 2 · In-Season","injury","Week 4","Horny Hank — Bent Axle",
     "Goats starter (Nolan) is out for the remainder of the regular season.","goats",None,None),
    ("m3",2,"Season 2 · In-Season","injury","Week 4","Toast Malone — Bent Axle",
     "Frogs starter (Nolan) will miss the next 2 games.","frogs",None,None),
    ("m4",2,"Season 2 · In-Season","lineup","Week 1","Guardians Shake Up the Lineup",
     "Brock Boulder is promoted to starter; Sir Blocksalot moves to the bench.","guardians",None,None),
    ("m5",2,"Season 2 · Draft Night","sign","Draft Night","Vipers Sign Donnie Dough",
     "Undrafted free agent joins the Vipers as Griffin\u2019s backup.","vipers",None,None),
    ("m6",2,"Season 2 · Draft Night","trade","Draft Night","Vipers \u21C4 Vortex",
     "Vipers send the #11 pick, Snakey Jake, and a S3 2nd-round pick to Vortex for the #4 overall pick.","vipers","vortex",None),
    ("m7",2,"Season 2 · Draft Night","trade","Draft Night","Coyotes \u21C4 Vortex",
     "Coyotes send the #4 pick and Dusty Paws to Vortex for the #3 pick and Dizzy Spin.","coyotes","vortex",None),
    ("m8",2,"Season 2 · Draft Night","draft","Draft Night","Season 2 Draft",
     "Rosters expand to four \u2014 each team adds a backup for Griffin and Nolan.",None,None,"s2"),
    ("m9",1,"Season 1 · Inaugural","draft","Preseason","Season 1 Inaugural Draft",
     "The league\u2019s first 20 selections set the original two-per-team rosters.",None,None,"s1"),
]


def main():
    cx = psycopg2.connect(DSN); cur = cx.cursor()

    cur.execute("SELECT slug, id FROM teams")
    team = dict(cur.fetchall())
    cur.execute("SELECT name, id FROM users")
    user = dict(cur.fetchall())
    cur.execute("SELECT number, id FROM seasons")
    season = dict(cur.fetchall())
    uid = {"G": user.get("Griffin"), "N": user.get("Nolan")}

    # roster metadata (upsert; creates roster-only players with no stat rows)
    for name, slug, u, role, origin, status, awards in ROSTER:
        cur.execute("""
            INSERT INTO players (name,user_id,team_id,role,origin,status,awards,on_roster)
            VALUES (%s,%s,%s,%s,%s,%s,%s,true)
            ON CONFLICT (name) DO UPDATE SET
              user_id=EXCLUDED.user_id, team_id=EXCLUDED.team_id, role=EXCLUDED.role,
              origin=EXCLUDED.origin, status=EXCLUDED.status, awards=EXCLUDED.awards,
              on_roster=true
        """, (name, uid.get(u), team.get(slug), role, origin, status, awards))

    # draft board (replace)
    cur.execute("TRUNCATE draft_board RESTART IDENTITY")
    for snum, picks in DRAFT_BOARD.items():
        for pick_no, slug, pname, owner in picks:
            cur.execute("""INSERT INTO draft_board (season_id,pick_no,team_id,player_name,owner)
                           VALUES (%s,%s,%s,%s,%s)""",
                        (season[snum], pick_no, team.get(slug), pname, owner))

    # moves (replace)
    cur.execute("TRUNCATE moves")
    for i, (mid, snum, phase, mtype, when, title, detail, a, b, picks) in enumerate(MOVES):
        cur.execute("""INSERT INTO moves
            (id,season_id,phase,type,when_label,title,detail,team_a,team_b,picks_ref,sort_order)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (mid, season.get(snum), phase, mtype, when, title, detail,
             team.get(a) if a else None, team.get(b) if b else None, picks, i))

    cx.commit()
    print(f"roster={len(ROSTER)} draft_board={sum(len(v) for v in DRAFT_BOARD.values())} moves={len(MOVES)}")
    cur.close(); cx.close()


if __name__ == "__main__":
    main()
