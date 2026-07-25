// Presentation constants for the NRL app.
//
// These are DESIGN TOKENS, not league data: team brand colors, abbreviations,
// nicknames, and the label/color lookup maps the UI uses. They were authored in
// the Claude Design export and have no home in the workbook, so they live in
// code. League data (stats, standings, results, champions) comes from the DB.

// Per-team branding, keyed by team slug (matches teams.slug in Postgres).
export const TEAM_BRAND = {
  barracudas: { abbr: 'BAR', conf: 'F', c: '#2d76a2', mono: false, tag: 'Deep Strikers' },
  surge:      { abbr: 'SRG', conf: 'F', c: '#18a6e6', mono: false, tag: 'Storm Chasers' },
  frogs:      { abbr: 'FRG', conf: 'F', c: '#5cb838', mono: false, tag: 'Leap Squad' },
  coyotes:    { abbr: 'COY', conf: 'F', c: '#d1743b', mono: false, tag: 'Desert Pack' },
  guardians:  { abbr: 'GRD', conf: 'F', c: '#2f74ac', mono: false, tag: 'The Wall' },
  turtles:    { abbr: 'TRT', conf: 'H', c: '#12a06a', mono: false, tag: 'Shellshock' },
  vipers:     { abbr: 'VPR', conf: 'H', c: '#2c9e53', mono: false, tag: 'Venom' },
  scorpions:  { abbr: 'SCP', conf: 'H', c: '#c93a3a', mono: false, tag: 'The Sting' },
  vortex:     { abbr: 'VTX', conf: 'H', c: '#6a3aad', mono: false, tag: 'The Storm' },
  goats:      { abbr: 'GOA', conf: 'H', c: '#3f8a63', mono: false, tag: 'Summit Kings' },
};

// Conferences (F = Frontier, H = Horizon).
export const CONFS = {
  F: { name: 'Frontier', abbr: 'FRO', color: '#4aa8ef' },
  H: { name: 'Horizon',  abbr: 'HOR', color: '#f5a24a' },
};

// The two league owners. Player.user is 'G' (Griffin) or 'N' (Nolan).
export const USER_META = {
  G: { name: 'Griffin', col: '#7fd0ff', tint: 'rgba(41,160,234,.16)' },
  N: { name: 'Nolan',   col: '#ffb47a', tint: 'rgba(245,130,45,.16)' },
};

// Map the DB user name -> the UI's single-letter key.
export const USER_KEY = { Griffin: 'G', Nolan: 'N' };

// Coach role labels.
export const ROLELABEL = { HC: 'Head Coach', OC: 'Offensive Coord.', DC: 'Defensive Coord.' };

// Roster-move types (Moves screen).
export const MTYPE = {
  trade:  { label: 'TRADE',   badge: 'TRD', color: '#46a6ef', tint: 'rgba(41,160,234,.15)' },
  draft:  { label: 'DRAFT',   badge: 'DFT', color: '#9b7cff', tint: 'rgba(155,124,255,.16)' },
  sign:   { label: 'SIGNING', badge: 'SGN', color: '#37c98a', tint: 'rgba(55,201,138,.15)' },
  injury: { label: 'INJURY',  badge: 'INJ', color: '#ff5f5f', tint: 'rgba(255,95,95,.15)' },
  lineup: { label: 'LINEUP',  badge: 'LNP', color: '#f5a531', tint: 'rgba(245,165,49,.15)' },
  cut:    { label: 'CUT',      badge: 'CUT', color: '#ff8a5f', tint: 'rgba(255,138,95,.15)' },
  coach:  { label: 'COACHING', badge: 'CCH', color: '#5fd0c9', tint: 'rgba(95,208,201,.15)' },
};

// Notification types.
export const NTYPE = {
  result: { tag: 'FINAL',  color: '#46a6ef', tint: 'rgba(41,160,234,.15)' },
  injury: { tag: 'INJURY', color: '#ff5f5f', tint: 'rgba(255,95,95,.15)' },
  roster: { tag: 'LINEUP', color: '#f5a531', tint: 'rgba(245,165,49,.15)' },
  news:   { tag: 'NEWS',   color: '#9b7cff', tint: 'rgba(155,124,255,.16)' },
};

// Round code -> display labels (used by the Scores screen).
export const RDLABEL = {
  W1: 'Week 1', W2: 'Week 2', W3: 'Week 3', W4: 'Week 4', W5: 'Week 5', W6: 'Week 6',
  QF: 'Quarterfinals', CF: 'Conference Finals', F: 'Finals',
};
export const RDSHORT = {
  W1: 'W1', W2: 'W2', W3: 'W3', W4: 'W4', W5: 'W5', W6: 'W6',
  QF: 'QF', CF: 'CF', F: 'F',
};

// The DB stores playoff rounds as full text; the UI keys on short codes.
export const PLAYOFF_ROUND_CODE = {
  Quarterfinals: 'QF',
  'Conference Finals': 'CF',
  Finals: 'F',
};
