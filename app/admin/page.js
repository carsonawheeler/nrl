'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

// Moderator screen for entering league data (games, seasons, players, drafts,
// moves, etc.) without touching the database directly. Every save posts to
// /api/admin with the shared admin password in the x-admin-token header; the
// server validates it and runs parameterized inserts. Dropdowns are populated
// from the DB so teams/seasons/players are picked, not retyped.

const TABS = [
  { id: 'game', label: 'Game', action: 'game', hint: 'Add a fixture or a played game. Leave scores blank for an upcoming game.' },
  { id: 'season', label: 'Season', action: 'season', hint: 'Start a new season.' },
  { id: 'player', label: 'Player', action: 'player', hint: 'Add a player to the league.' },
  { id: 'playerStats', label: 'Player Stats', action: 'playerStats', hint: 'Add or update a player\u2019s stat line for a season. Re-saving overwrites.' },
  { id: 'draftPick', label: 'Draft Pick', action: 'draftPick', hint: 'Add a pick to a season draft board. Re-saving the same pick number overwrites.' },
  { id: 'move', label: 'Move', action: 'move', hint: 'Add a roster move / transaction to the feed.' },
  { id: 'freeAgent', label: 'Free Agent', action: 'freeAgent', hint: 'Add a free agent to the pool.' },
  { id: 'team', label: 'Team', action: 'team', hint: 'Add a team.' },
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
    case 'game':
      return [
        { key: 'season_id', label: 'Season', type: 'select', options: seasonOpts, required: true },
        { key: 'is_playoff', label: 'Playoff game', type: 'checkbox' },
        { key: 'week', label: 'Week (regular season)', type: 'number', placeholder: 'e.g. 1' },
        { key: 'round', label: 'Round (playoffs)', type: 'select', options: ROUND_OPTS, placeholder: '—' },
        { key: 'away_team_id', label: 'Away team', type: 'select', options: teamOpts, required: true },
        { key: 'away_score', label: 'Away score', type: 'number', placeholder: 'blank = TBD' },
        { key: 'home_team_id', label: 'Home team', type: 'select', options: teamOpts, required: true },
        { key: 'home_score', label: 'Home score', type: 'number', placeholder: 'blank = TBD' },
        { key: 'away_seed', label: 'Away seed (playoffs)', type: 'number' },
        { key: 'home_seed', label: 'Home seed (playoffs)', type: 'number' },
      ];
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
        { key: 'name', label: 'Player name', type: 'text', required: true },
        { key: 'user_id', label: 'Manager', type: 'select', options: userOpts },
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
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'user_id', label: 'Manager (if cut)', type: 'select', options: userOpts },
        { key: 'star_rating', label: 'Star rating (if undrafted)', type: 'number' },
      ];
    default:
      return [];
  }
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

export default function AdminPage() {
  const [token, setToken] = useState('');
  const [authed, setAuthed] = useState(false);
  const [meta, setMeta] = useState({ teams: [], seasons: [], players: [], users: [] });
  const [tab, setTab] = useState('game');
  const [form, setForm] = useState({});
  const [msg, setMsg] = useState(null); // { ok, text }
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

  // Restore a saved session token on mount.
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
      setToken(pwInput);
      setMeta(m);
      setAuthed(true);
      try { localStorage.setItem('nrl_admin_token', pwInput); } catch {}
    } catch (err) {
      setPwError(err.message);
    }
  };

  const signOut = () => {
    try { localStorage.removeItem('nrl_admin_token'); } catch {}
    setAuthed(false);
    setToken('');
    setPwInput('');
  };

  const fields = useMemo(() => (authed ? fieldsFor(tab, meta) : []), [authed, tab, meta]);

  const setField = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const action = TABS.find((t) => t.id === tab).action;
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ action, data: form }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Save failed.');
      setMsg({ ok: true, text: body.message || 'Saved.' });
      setForm({});
      // Adding a season/player/team changes the dropdowns — refresh them.
      if (['season', 'player', 'team'].includes(tab)) {
        loadMeta(token).then(setMeta).catch(() => {});
      }
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = {
    width: '100%', boxSizing: 'border-box', background: C.input, border: `1px solid ${C.border}`,
    borderRadius: 10, color: C.text, font: "500 14px system-ui, sans-serif", padding: '10px 12px', outline: 'none',
  };
  const labelStyle = { display: 'block', font: "600 12px system-ui, sans-serif", letterSpacing: '.4px', color: C.dim, textTransform: 'uppercase', margin: '0 0 6px' };

  if (!authed) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, color: C.text, display: 'grid', placeItems: 'center', padding: 20 }}>
        <form onSubmit={signIn} style={{ width: '100%', maxWidth: 360, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24 }}>
          <h1 style={{ font: "800 20px system-ui, sans-serif", margin: '0 0 4px' }}>NRL Admin</h1>
          <p style={{ font: "500 13px system-ui, sans-serif", color: C.dim, margin: '0 0 18px' }}>Enter the admin password to manage league data.</p>
          <input
            type="password" autoFocus value={pwInput} onChange={(e) => setPwInput(e.target.value)}
            placeholder="Admin password" style={inputStyle} aria-label="Admin password"
          />
          {pwError ? <div style={{ color: '#ff7a7a', font: "500 12.5px system-ui, sans-serif", marginTop: 10 }}>{pwError}</div> : null}
          <button type="submit" style={{ width: '100%', marginTop: 16, background: C.accent, color: '#04121f', border: 'none', borderRadius: 10, font: "800 14px system-ui, sans-serif", padding: '11px 0', cursor: 'pointer' }}>
            Sign in
          </button>
        </form>
      </div>
    );
  }

  const activeTab = TABS.find((t) => t.id === tab);

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, padding: '0 0 60px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '22px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <h1 style={{ font: "800 22px system-ui, sans-serif", margin: 0 }}>NRL Admin</h1>
          <button onClick={signOut} style={{ background: 'transparent', color: C.dim, border: `1px solid ${C.border}`, borderRadius: 9, font: "600 12px system-ui, sans-serif", padding: '7px 12px', cursor: 'pointer' }}>
            Sign out
          </button>
        </div>
        <p style={{ font: "500 13px system-ui, sans-serif", color: C.dim, margin: '0 0 18px' }}>
          Saved changes appear on the site the next time it loads.
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                onClick={() => { setTab(t.id); setForm({}); setMsg(null); }}
                style={{
                  border: `1px solid ${active ? '#2c6c98' : C.border}`, cursor: 'pointer',
                  background: active ? '#173650' : 'rgba(255,255,255,.04)', color: active ? '#7fd0ff' : '#9db2cc',
                  font: "700 12.5px system-ui, sans-serif", padding: '8px 14px', borderRadius: 20,
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        <form onSubmit={submit} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, padding: 20 }}>
          <p style={{ font: "500 13px system-ui, sans-serif", color: C.dim, margin: '0 0 16px' }}>{activeTab.hint}</p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            {fields.map((f) => (
              <div key={f.key} style={{ gridColumn: f.type === 'textarea' ? '1 / -1' : 'auto' }}>
                <label style={labelStyle} htmlFor={`fld-${f.key}`}>
                  {f.label}{f.required ? <span style={{ color: '#ff7a7a' }}> *</span> : null}
                </label>
                {f.type === 'select' ? (
                  <select id={`fld-${f.key}`} value={form[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)} style={inputStyle}>
                    <option value="">{f.placeholder || '—'}</option>
                    {f.options.map((o) => (
                      <option key={String(o.value)} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : f.type === 'textarea' ? (
                  <textarea id={`fld-${f.key}`} value={form[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)} rows={3} placeholder={f.placeholder || ''} style={{ ...inputStyle, resize: 'vertical' }} />
                ) : f.type === 'checkbox' ? (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', font: "500 14px system-ui, sans-serif", color: C.text, padding: '10px 0' }}>
                    <input id={`fld-${f.key}`} type="checkbox" checked={!!form[f.key]} onChange={(e) => setField(f.key, e.target.checked)} style={{ width: 18, height: 18 }} />
                    {form[f.key] ? 'Yes' : 'No'}
                  </label>
                ) : (
                  <input
                    id={`fld-${f.key}`} type={f.type === 'number' ? 'number' : 'text'} step="any"
                    value={form[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)}
                    placeholder={f.placeholder || ''} style={inputStyle}
                  />
                )}
              </div>
            ))}
          </div>

          {msg ? (
            <div style={{ marginTop: 16, padding: '10px 12px', borderRadius: 10, font: "600 13px system-ui, sans-serif",
              background: msg.ok ? 'rgba(55,201,138,.14)' : 'rgba(255,95,95,.14)', color: msg.ok ? '#5fe0a6' : '#ff9a9a',
              border: `1px solid ${msg.ok ? 'rgba(55,201,138,.3)' : 'rgba(255,95,95,.3)'}` }}>
              {msg.text}
            </div>
          ) : null}

          <button type="submit" disabled={busy} style={{ marginTop: 18, background: busy ? '#2b4a63' : C.accent, color: '#04121f', border: 'none', borderRadius: 10, font: "800 14px system-ui, sans-serif", padding: '12px 22px', cursor: busy ? 'default' : 'pointer' }}>
            {busy ? 'Saving…' : `Save ${activeTab.label}`}
          </button>
        </form>
      </div>
    </div>
  );
}
