'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

// Moderator screen for entering league data (games with box scores, seasons,
// players, drafts, moves, etc.) without touching the database directly. Every
// save posts to /api/admin with the shared admin password in the x-admin-token
// header; the server validates it and runs parameterized inserts. Dropdowns are
// populated from the DB so teams/seasons/players are picked, not retyped.
//
// Box scores drive the numbers: entering per-player lines for a game recomputes
// that player's season stats (career totals are a live view, so they follow),
// and posts a result to the news feed automatically.

const TABS = [
  { id: 'boxScore', label: 'Box Score', kind: 'boxScore', hint: 'Enter a game and each player\u2019s line. Season + career stats update automatically and a result posts to the news feed.' },
  { id: 'season', label: 'Season', kind: 'form', action: 'season', hint: 'Start a new season. Posts a news item.' },
  { id: 'player', label: 'Player', kind: 'form', action: 'player', editAction: 'editPlayer', hint: 'Add a player, or pick one to edit their team, role, status, and awards.' },
  { id: 'playerStats', label: 'Player Stats', kind: 'form', action: 'playerStats', hint: 'Manually set a player\u2019s stat line for a season (overwrites). Box scores usually do this for you.' },
  { id: 'draftPick', label: 'Draft Pick', kind: 'form', action: 'draftPick', hint: 'Add or overwrite a single pick on a season draft board.' },
  { id: 'draftClass', label: 'Draft Class', kind: 'draftClass', hint: 'Enter a whole draft at once. Posts to both the moves feed and the news feed.' },
  { id: 'move', label: 'Move', kind: 'form', action: 'move', editAction: 'editMove', hint: 'Add a roster move / transaction, or pick one to edit.' },
  { id: 'freeAgent', label: 'Free Agent', kind: 'form', action: 'freeAgent', editAction: 'editFreeAgent', hint: 'Add a free agent, or pick one to edit.' },
  { id: 'team', label: 'Team', kind: 'form', action: 'team', hint: 'Add a team.' },
];

const OWNER_OPTS = [
  { value: 'G', label: 'Griffin (G)' },
  { value: 'N', label: 'Nolan (N)' },
  { value: 'F', label: 'Forfeited (F)' },
];
const CONF_OPTS = [
  { value: 'F', label: 'Frontier (F)' },
  { value: 'H', label: 'Horizon (H)' },
];
const ROLE_OPTS = [
  { value: 'S', label: 'Starter (S)' },
  { value: 'B', label: 'Backup (B)' },
];
const MOVE_TYPE_OPTS = ['trade', 'draft', 'sign', 'injury', 'lineup', 'cut', 'coach'].map((v) => ({ value: v, label: v }));
const ROUND_OPTS = ['Quarterfinals', 'Conference Finals', 'Finals'].map((v) => ({ value: v, label: v }));

// Field descriptors per tab, built from the loaded reference lists.
function fieldsFor(tabId, meta) {
  const teamOpts = meta.teams.map((t) => ({ value: t.id, label: t.name }));
  const seasonOpts = meta.seasons.map((s) => ({ value: s.id, label: 'Season ' + s.number }));
  const playerOpts = meta.players.map((p) => ({ value: p.id, label: p.name }));
  const userOpts = meta.users.map((u) => ({ value: u.id, label: u.name }));

  switch (tabId) {
    case 'season':
      return [
        { key: 'number', label: 'Season number', type: 'number', required: true, placeholder: 'e.g. 4' },
        { key: 'logo', label: 'Logo path', type: 'text', placeholder: '/logos/champ4.webp (optional)' },
      ];
    case 'team':
      return [
        { key: 'name', label: 'Team name', type: 'text', required: true },
        { key: 'slug', label: 'Slug', type: 'text', required: true, placeholder: 'lowercase, e.g. sharks' },
        { key: 'conference', label: 'Conference', type: 'select', options: CONF_OPTS },
        { key: 'logo', label: 'Logo path', type: 'text', placeholder: '/logos/sharks.webp (optional)' },
      ];
    case 'player':
      return [
        { key: 'name', label: 'Player name', type: 'text', required: true, editHidden: true },
        { key: 'user_id', label: 'Manager', type: 'select', options: userOpts, editHidden: true },
        { key: 'team_id', label: 'Team', type: 'select', options: teamOpts },
        { key: 'role', label: 'Role', type: 'select', options: ROLE_OPTS },
        { key: 'origin', label: 'Origin', type: 'text', placeholder: 'e.g. S3 Draft · Pick 1' },
        { key: 'status', label: 'Status', type: 'text', placeholder: 'inj / out / bench (optional)' },
        { key: 'awards', label: 'Awards', type: 'text', placeholder: 'comma-separated (optional)' },
        { key: 'on_roster', label: 'On current roster', type: 'checkbox' },
      ];
    case 'playerStats':
      return [
        { key: 'player_id', label: 'Player', type: 'select', options: playerOpts, required: true },
        { key: 'season_id', label: 'Season', type: 'select', options: seasonOpts, required: true },
        { key: 'team_id', label: 'Team (that season)', type: 'select', options: teamOpts },
        { key: 'is_playoff', label: 'Playoff stats', type: 'checkbox' },
        { key: 'games', label: 'Games', type: 'number' },
        { key: 'goals', label: 'Goals', type: 'number' },
        { key: 'assists', label: 'Assists', type: 'number' },
        { key: 'saves', label: 'Saves', type: 'number' },
        { key: 'shots', label: 'Shots', type: 'number' },
        { key: 'wins', label: 'Wins', type: 'number' },
        { key: 'rings', label: 'Rings', type: 'number' },
        { key: 'score', label: 'Score', type: 'number' },
        { key: 'awards', label: 'Awards', type: 'text', placeholder: '(optional)' },
      ];
    case 'draftPick':
      return [
        { key: 'season_id', label: 'Season', type: 'select', options: seasonOpts, required: true },
        { key: 'pick_no', label: 'Pick number', type: 'number', required: true },
        { key: 'team_id', label: 'Team', type: 'select', options: teamOpts },
        { key: 'player_name', label: 'Player name', type: 'text', placeholder: 'blank = forfeited' },
        { key: 'owner', label: 'Owner', type: 'select', options: OWNER_OPTS },
      ];
    case 'move':
      return [
        { key: 'type', label: 'Type', type: 'select', options: MOVE_TYPE_OPTS, required: true },
        { key: 'title', label: 'Title', type: 'text', required: true },
        { key: 'detail', label: 'Detail', type: 'textarea' },
        { key: 'season_id', label: 'Season', type: 'select', options: seasonOpts },
        { key: 'phase', label: 'Phase', type: 'text', placeholder: 'e.g. Season 3 · Preseason' },
        { key: 'when_label', label: 'When', type: 'text', placeholder: 'e.g. Week 4, Draft Night' },
        { key: 'team_a', label: 'Team A', type: 'select', options: teamOpts },
        { key: 'team_b', label: 'Team B', type: 'select', options: teamOpts },
        { key: 'picks_ref', label: 'Picks reference', type: 'text', placeholder: 's1 / s2 / s3 (optional)' },
      ];
    case 'freeAgent':
      return [
        { key: 'name', label: 'Name', type: 'text', required: true, editHidden: true },
        { key: 'user_id', label: 'Manager (if cut)', type: 'select', options: userOpts },
        { key: 'star_rating', label: 'Star rating (if undrafted)', type: 'number' },
      ];
    default:
      return [];
  }
}

// Maps an existing record (from meta) into form values for the edit path.
function recordToForm(tabId, rec) {
  switch (tabId) {
    case 'player':
      return {
        id: rec.id, team_id: rec.team_id ?? '', role: rec.role ?? '', origin: rec.origin ?? '',
        status: rec.status ?? '', awards: Array.isArray(rec.awards) ? rec.awards.join(', ') : (rec.awards ?? ''),
        on_roster: !!rec.on_roster,
      };
    case 'move':
      return {
        id: rec.id, season_id: rec.season_id ?? '', phase: rec.phase ?? '', type: rec.type ?? '',
        when_label: rec.when_label ?? '', title: rec.title ?? '', detail: rec.detail ?? '',
        team_a: rec.team_a ?? '', team_b: rec.team_b ?? '', picks_ref: rec.picks_ref ?? '',
      };
    case 'freeAgent':
      return { id: rec.id, user_id: rec.user_id ?? '', star_rating: rec.star_rating ?? '' };
    default:
      return { id: rec.id };
  }
}

function editRecords(tabId, meta) {
  if (tabId === 'player') return (meta.players || []).map((p) => ({ id: p.id, label: p.name, rec: p }));
  if (tabId === 'move') return (meta.moves || []).map((m) => ({ id: m.id, label: `${m.title} (${m.type})`, rec: m }));
  if (tabId === 'freeAgent') return (meta.freeAgents || []).map((f) => ({ id: f.id, label: f.name, rec: f }));
  return [];
}

const C = {
  bg: '#0a1420',
  panel: '#0f1e2d',
  input: '#0c1826',
  border: 'rgba(255,255,255,.09)',
  text: '#eef4fb',
  dim: '#8ea3bd',
  accent: '#4aa8ef',
};

const inputStyle = {
  width: '100%', boxSizing: 'border-box', background: C.input, border: `1px solid ${C.border}`,
  borderRadius: 10, color: C.text, font: '500 14px system-ui, sans-serif', padding: '10px 12px', outline: 'none',
};
const labelStyle = { display: 'block', font: '600 12px system-ui, sans-serif', letterSpacing: '.4px', color: C.dim, textTransform: 'uppercase', margin: '0 0 6px' };
const btnStyle = { background: C.accent, color: '#04121f', border: 'none', borderRadius: 10, font: '800 14px system-ui, sans-serif', padding: '12px 22px', cursor: 'pointer' };
const ghostBtn = { background: 'transparent', color: C.dim, border: `1px solid ${C.border}`, borderRadius: 9, font: '600 12px system-ui, sans-serif', padding: '7px 12px', cursor: 'pointer' };

function Field({ f, value, onChange }) {
  return (
    <div style={{ gridColumn: f.type === 'textarea' ? '1 / -1' : 'auto' }}>
      <label style={labelStyle} htmlFor={`fld-${f.key}`}>
        {f.label}{f.required ? <span style={{ color: '#ff7a7a' }}> *</span> : null}
      </label>
      {f.type === 'select' ? (
        <select id={`fld-${f.key}`} value={value ?? ''} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
          <option value="">{f.placeholder || '—'}</option>
          {f.options.map((o) => (<option key={String(o.value)} value={o.value}>{o.label}</option>))}
        </select>
      ) : f.type === 'textarea' ? (
        <textarea id={`fld-${f.key}`} value={value ?? ''} onChange={(e) => onChange(e.target.value)} rows={3} placeholder={f.placeholder || ''} style={{ ...inputStyle, resize: 'vertical' }} />
      ) : f.type === 'checkbox' ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', font: '500 14px system-ui, sans-serif', color: C.text, padding: '10px 0' }}>
          <input id={`fld-${f.key}`} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} style={{ width: 18, height: 18 }} />
          {value ? 'Yes' : 'No'}
        </label>
      ) : (
        <input id={`fld-${f.key}`} type={f.type === 'number' ? 'number' : 'text'} step="any"
          value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder || ''} style={inputStyle} />
      )}
    </div>
  );
}

// ---- Box Score panel: game header + per-player lines ----
function BoxScorePanel({ meta, token, onSaved }) {
  const emptyRow = () => ({ player_id: '', team_id: '', goals: '', assists: '', saves: '', shots: '' });
  const [game, setGame] = useState({ game_id: '', season_id: '', is_playoff: false, week: '', round: '', game_no: '', away_team_id: '', home_team_id: '', away_score: '', home_score: '', away_seed: '', home_seed: '' });
  const [rows, setRows] = useState([emptyRow()]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const teamOpts = meta.teams.map((t) => ({ value: t.id, label: t.name }));
  const seasonOpts = meta.seasons.map((s) => ({ value: s.id, label: 'Season ' + s.number }));
  const playerOpts = meta.players.map((p) => ({ value: p.id, label: p.name }));
  // Only the two teams in this game are valid box-score teams.
  const rowTeamOpts = teamOpts.filter((t) => t.value === Number(game.away_team_id) || t.value === Number(game.home_team_id));

  const setG = (k, v) => setGame((g) => ({ ...g, [k]: v }));
  const setRow = (i, k, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  // Default a player's box team to their current team when picked.
  const pickPlayer = (i, pid) => {
    const p = meta.players.find((x) => String(x.id) === String(pid));
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, player_id: pid, team_id: r.team_id || (p && p.team_id ? p.team_id : '') } : r)));
  };

  const loadGame = async (id) => {
    setMsg(null);
    if (!id) {
      setGame({ game_id: '', season_id: '', is_playoff: false, week: '', round: '', game_no: '', away_team_id: '', home_team_id: '', away_score: '', home_score: '', away_seed: '', home_seed: '' });
      setRows([emptyRow()]);
      return;
    }
    const g = meta.games.find((x) => String(x.id) === String(id));
    if (!g) return;
    const season = meta.seasons.find((s) => s.number === g.season);
    setGame({
      game_id: g.id, season_id: season ? season.id : '', is_playoff: !!g.is_playoff, week: g.week ?? '',
      round: g.round ?? '', game_no: g.game_no ?? '', away_team_id: g.away_team_id ?? '', home_team_id: g.home_team_id ?? '',
      away_score: g.away_score ?? '', home_score: g.home_score ?? '', away_seed: g.away_seed ?? '', home_seed: g.home_seed ?? '',
    });
    try {
      const res = await fetch(`/api/admin?box=${g.id}`, { headers: { 'x-admin-token': token } });
      const body = await res.json().catch(() => ({}));
      const box = Array.isArray(body.box) ? body.box : [];
      setRows(box.length ? box.map((b) => ({ player_id: b.player_id, team_id: b.team_id ?? '', goals: b.goals, assists: b.assists, saves: b.saves, shots: b.shots })) : [emptyRow()]);
    } catch { setRows([emptyRow()]); }
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const box = rows.filter((r) => r.player_id).map((r) => ({
        player_id: Number(r.player_id), team_id: r.team_id ? Number(r.team_id) : null,
        goals: Number(r.goals) || 0, assists: Number(r.assists) || 0, saves: Number(r.saves) || 0, shots: Number(r.shots) || 0,
      }));
      const res = await fetch('/api/admin', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ action: 'gameWithBox', data: { ...game, box } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Save failed.');
      setMsg({ ok: true, text: body.message || 'Saved.' });
      onSaved && onSaved();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally { setBusy(false); }
  };

  const gameOpts = meta.games.map((g) => ({ value: g.id, label: `S${g.season} ${g.is_playoff ? g.round || 'PO' : 'W' + (g.week ?? '?')} · ${g.away || '?'} @ ${g.home || '?'} ${g.away_score != null ? `(${g.away_score}-${g.home_score})` : ''}` }));

  return (
    <form onSubmit={save} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, padding: 20 }}>
      <p style={{ font: '500 13px system-ui, sans-serif', color: C.dim, margin: '0 0 16px' }}>
        Enter a game and each player&rsquo;s line. Season + career stats update automatically and a result posts to the news feed.
      </p>

      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Edit an existing game (optional)</label>
        <select value={game.game_id} onChange={(e) => loadGame(e.target.value)} style={inputStyle}>
          <option value="">— New game —</option>
          {gameOpts.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
        <Field f={{ key: 'season_id', label: 'Season', type: 'select', options: seasonOpts, required: true }} value={game.season_id} onChange={(v) => setG('season_id', v)} />
        <Field f={{ key: 'is_playoff', label: 'Playoff game', type: 'checkbox' }} value={game.is_playoff} onChange={(v) => setG('is_playoff', v)} />
        <Field f={{ key: 'week', label: 'Week', type: 'number', placeholder: 'regular season' }} value={game.week} onChange={(v) => setG('week', v)} />
        <Field f={{ key: 'round', label: 'Round', type: 'select', options: ROUND_OPTS, placeholder: 'playoffs' }} value={game.round} onChange={(v) => setG('round', v)} />
        <Field f={{ key: 'away_team_id', label: 'Away team', type: 'select', options: teamOpts, required: true }} value={game.away_team_id} onChange={(v) => setG('away_team_id', v)} />
        <Field f={{ key: 'away_score', label: 'Away score', type: 'number', placeholder: 'blank = TBD' }} value={game.away_score} onChange={(v) => setG('away_score', v)} />
        <Field f={{ key: 'home_team_id', label: 'Home team', type: 'select', options: teamOpts, required: true }} value={game.home_team_id} onChange={(v) => setG('home_team_id', v)} />
        <Field f={{ key: 'home_score', label: 'Home score', type: 'number', placeholder: 'blank = TBD' }} value={game.home_score} onChange={(v) => setG('home_score', v)} />
      </div>

      <div style={{ marginTop: 22, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ ...labelStyle, margin: 0 }}>Box score</span>
        <button type="button" onClick={() => setRows((rs) => [...rs, emptyRow()])} style={ghostBtn}>+ Add player</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1.6fr repeat(4, .8fr) auto', gap: 8, alignItems: 'center' }}>
            <select value={r.player_id} onChange={(e) => pickPlayer(i, e.target.value)} style={inputStyle} aria-label="Player">
              <option value="">Player…</option>
              {playerOpts.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
            <select value={r.team_id} onChange={(e) => setRow(i, 'team_id', e.target.value)} style={inputStyle} aria-label="Team">
              <option value="">Team…</option>
              {(rowTeamOpts.length ? rowTeamOpts : teamOpts).map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
            {['goals', 'assists', 'saves', 'shots'].map((k) => (
              <input key={k} type="number" value={r[k]} onChange={(e) => setRow(i, k, e.target.value)} placeholder={k[0].toUpperCase()} title={k} style={{ ...inputStyle, padding: '10px 8px', textAlign: 'center' }} />
            ))}
            <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} style={{ ...ghostBtn, padding: '9px 11px' }} aria-label="Remove">✕</button>
          </div>
        ))}
      </div>
      <p style={{ font: '500 11.5px system-ui, sans-serif', color: C.dim, margin: '8px 0 0' }}>Columns: Goals · Assists · Saves · Shots. Wins are derived from the final score and each player&rsquo;s team.</p>

      {msg ? <Msg msg={msg} /> : null}
      <button type="submit" disabled={busy} style={{ ...btnStyle, marginTop: 18, background: busy ? '#2b4a63' : C.accent, cursor: busy ? 'default' : 'pointer' }}>
        {busy ? 'Saving…' : 'Save game + box score'}
      </button>
    </form>
  );
}

// ---- Draft Class panel: a season plus a table of picks ----
function DraftClassPanel({ meta, token, onSaved }) {
  const emptyPick = (n) => ({ pick_no: n, team_id: '', player_name: '', owner: '' });
  const [seasonId, setSeasonId] = useState('');
  const [picks, setPicks] = useState([emptyPick(1), emptyPick(2), emptyPick(3), emptyPick(4)]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const teamOpts = meta.teams.map((t) => ({ value: t.id, label: t.name }));
  const seasonOpts = meta.seasons.map((s) => ({ value: s.id, label: 'Season ' + s.number }));
  const setPick = (i, k, v) => setPicks((ps) => ps.map((p, j) => (j === i ? { ...p, [k]: v } : p)));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      if (!seasonId) throw new Error('Season is required.');
      const clean = picks.filter((p) => p.pick_no !== '' && p.pick_no != null).map((p) => ({
        pick_no: Number(p.pick_no), team_id: p.team_id ? Number(p.team_id) : null,
        player_name: p.player_name || null, owner: p.owner || null,
      }));
      const res = await fetch('/api/admin', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ action: 'draftClass', data: { season_id: Number(seasonId), picks: clean } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Save failed.');
      setMsg({ ok: true, text: body.message || 'Saved.' });
      onSaved && onSaved();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={save} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, padding: 20 }}>
      <p style={{ font: '500 13px system-ui, sans-serif', color: C.dim, margin: '0 0 16px' }}>
        Enter a whole draft at once. Posts to both the moves feed and the news feed.
      </p>
      <div style={{ maxWidth: 260, marginBottom: 18 }}>
        <label style={labelStyle}>Season <span style={{ color: '#ff7a7a' }}>*</span></label>
        <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)} style={inputStyle}>
          <option value="">—</option>
          {seasonOpts.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
        </select>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ ...labelStyle, margin: 0 }}>Picks</span>
        <button type="button" onClick={() => setPicks((ps) => [...ps, emptyPick(ps.length + 1)])} style={ghostBtn}>+ Add pick</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {picks.map((p, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '.7fr 1.6fr 2fr 1.2fr auto', gap: 8, alignItems: 'center' }}>
            <input type="number" value={p.pick_no} onChange={(e) => setPick(i, 'pick_no', e.target.value)} placeholder="#" style={{ ...inputStyle, padding: '10px 8px', textAlign: 'center' }} aria-label="Pick number" />
            <select value={p.team_id} onChange={(e) => setPick(i, 'team_id', e.target.value)} style={inputStyle} aria-label="Team">
              <option value="">Team…</option>
              {teamOpts.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
            <input value={p.player_name} onChange={(e) => setPick(i, 'player_name', e.target.value)} placeholder="Player name (blank = forfeited)" style={inputStyle} aria-label="Player name" />
            <select value={p.owner} onChange={(e) => setPick(i, 'owner', e.target.value)} style={inputStyle} aria-label="Owner">
              <option value="">Owner…</option>
              {OWNER_OPTS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
            <button type="button" onClick={() => setPicks((ps) => ps.filter((_, j) => j !== i))} style={{ ...ghostBtn, padding: '9px 11px' }} aria-label="Remove">✕</button>
          </div>
        ))}
      </div>

      {msg ? <Msg msg={msg} /> : null}
      <button type="submit" disabled={busy} style={{ ...btnStyle, marginTop: 18, background: busy ? '#2b4a63' : C.accent, cursor: busy ? 'default' : 'pointer' }}>
        {busy ? 'Saving…' : 'Save draft class'}
      </button>
    </form>
  );
}

function Msg({ msg }) {
  return (
    <div style={{ marginTop: 16, padding: '10px 12px', borderRadius: 10, font: '600 13px system-ui, sans-serif',
      background: msg.ok ? 'rgba(55,201,138,.14)' : 'rgba(255,95,95,.14)', color: msg.ok ? '#5fe0a6' : '#ff9a9a',
      border: `1px solid ${msg.ok ? 'rgba(55,201,138,.3)' : 'rgba(255,95,95,.3)'}` }}>
      {msg.text}
    </div>
  );
}

export default function AdminPage() {
  const [token, setToken] = useState('');
  const [authed, setAuthed] = useState(false);
  const [meta, setMeta] = useState({ teams: [], seasons: [], players: [], users: [], games: [], moves: [], freeAgents: [] });
  const [tab, setTab] = useState('boxScore');
  const [form, setForm] = useState({});
  const [editId, setEditId] = useState(''); // record id when editing an existing row
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pwInput, setPwInput] = useState('');
  const [pwError, setPwError] = useState('');

  const loadMeta = useCallback(async (tok) => {
    const res = await fetch('/api/admin', { headers: { 'x-admin-token': tok } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Authentication failed.');
    }
    return res.json();
  }, []);

  const refreshMeta = useCallback(() => { if (token) loadMeta(token).then(setMeta).catch(() => {}); }, [token, loadMeta]);

  useEffect(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('nrl_admin_token') : '';
    if (!saved) return;
    loadMeta(saved)
      .then((m) => { setToken(saved); setMeta(m); setAuthed(true); })
      .catch(() => localStorage.removeItem('nrl_admin_token'));
  }, [loadMeta]);

  const signIn = async (e) => {
    e.preventDefault();
    setPwError('');
    try {
      const m = await loadMeta(pwInput);
      setToken(pwInput); setMeta(m); setAuthed(true);
      try { localStorage.setItem('nrl_admin_token', pwInput); } catch {}
    } catch (err) { setPwError(err.message); }
  };

  const signOut = () => {
    try { localStorage.removeItem('nrl_admin_token'); } catch {}
    setAuthed(false); setToken(''); setPwInput('');
  };

  const activeTab = TABS.find((t) => t.id === tab);
  const allFields = useMemo(() => (authed ? fieldsFor(tab, meta) : []), [authed, tab, meta]);
  // In edit mode, hide identity fields (name/manager) that shouldn't change.
  const fields = editId ? allFields.filter((f) => !f.editHidden) : allFields;

  const setField = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const switchTab = (id) => { setTab(id); setForm({}); setEditId(''); setMsg(null); };

  const pickEdit = (val) => {
    setMsg(null);
    if (!val) { setEditId(''); setForm({}); return; }
    const recs = editRecords(tab, meta);
    const found = recs.find((r) => String(r.id) === String(val));
    if (!found) return;
    setEditId(val);
    setForm(recordToForm(tab, found.rec));
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const action = editId && activeTab.editAction ? activeTab.editAction : activeTab.action;
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ action, data: form }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Save failed.');
      setMsg({ ok: true, text: body.message || 'Saved.' });
      if (!editId) setForm({});
      // Any add/edit can change dropdown contents — refresh the reference lists.
      loadMeta(token).then(setMeta).catch(() => {});
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally { setBusy(false); }
  };

  if (!authed) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, color: C.text, display: 'grid', placeItems: 'center', padding: 20 }}>
        <form onSubmit={signIn} style={{ width: '100%', maxWidth: 360, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24 }}>
          <h1 style={{ font: '800 20px system-ui, sans-serif', margin: '0 0 4px' }}>NRL Admin</h1>
          <p style={{ font: '500 13px system-ui, sans-serif', color: C.dim, margin: '0 0 18px' }}>Enter the admin password to manage league data.</p>
          <input type="password" autoFocus value={pwInput} onChange={(e) => setPwInput(e.target.value)} placeholder="Admin password" style={inputStyle} aria-label="Admin password" />
          {pwError ? <div style={{ color: '#ff7a7a', font: '500 12.5px system-ui, sans-serif', marginTop: 10 }}>{pwError}</div> : null}
          <button type="submit" style={{ ...btnStyle, width: '100%', marginTop: 16, padding: '11px 0' }}>Sign in</button>
        </form>
      </div>
    );
  }

  const editList = activeTab.editAction ? editRecords(tab, meta) : [];

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, padding: '0 0 60px' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '22px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <h1 style={{ font: '800 22px system-ui, sans-serif', margin: 0 }}>NRL Admin</h1>
          <button onClick={signOut} style={ghostBtn}>Sign out</button>
        </div>
        <p style={{ font: '500 13px system-ui, sans-serif', color: C.dim, margin: '0 0 18px' }}>
          Saved changes appear on the site the next time it loads.
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button key={t.id} onClick={() => switchTab(t.id)} style={{
                border: `1px solid ${active ? '#2c6c98' : C.border}`, cursor: 'pointer',
                background: active ? '#173650' : 'rgba(255,255,255,.04)', color: active ? '#7fd0ff' : '#9db2cc',
                font: '700 12.5px system-ui, sans-serif', padding: '8px 14px', borderRadius: 20,
              }}>{t.label}</button>
            );
          })}
        </div>

        {activeTab.kind === 'boxScore' ? (
          <BoxScorePanel meta={meta} token={token} onSaved={refreshMeta} />
        ) : activeTab.kind === 'draftClass' ? (
          <DraftClassPanel meta={meta} token={token} onSaved={refreshMeta} />
        ) : (
          <form onSubmit={submit} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, padding: 20 }}>
            <p style={{ font: '500 13px system-ui, sans-serif', color: C.dim, margin: '0 0 16px' }}>{activeTab.hint}</p>

            {activeTab.editAction ? (
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Edit an existing {activeTab.label.toLowerCase()} (optional)</label>
                <select value={editId} onChange={(e) => pickEdit(e.target.value)} style={inputStyle}>
                  <option value="">— Add new —</option>
                  {editList.map((r) => (<option key={String(r.id)} value={r.id}>{r.label}</option>))}
                </select>
              </div>
            ) : null}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
              {fields.map((f) => (
                <Field key={f.key} f={f} value={form[f.key]} onChange={(v) => setField(f.key, v)} />
              ))}
            </div>

            {msg ? <Msg msg={msg} /> : null}

            <button type="submit" disabled={busy} style={{ ...btnStyle, marginTop: 18, background: busy ? '#2b4a63' : C.accent, cursor: busy ? 'default' : 'pointer' }}>
              {busy ? 'Saving…' : editId ? `Update ${activeTab.label}` : `Save ${activeTab.label}`}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
