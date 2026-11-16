// Countdown ticking and live server status for the LAN intranet page.
(() => {
  const root = document.querySelector('[data-intranet]');
  if (!root) return;
  const cd = root.querySelector('[data-countdown]');
  if (cd) {
    const target = Date.parse(cd.getAttribute('data-countdown'));
    const parts = { d: cd.querySelector('[data-cd="d"]'), h: cd.querySelector('[data-cd="h"]'), m: cd.querySelector('[data-cd="m"]'), s: cd.querySelector('[data-cd="s"]') };
    const tick = () => {
      let t = Math.max(0, Math.floor((target - Date.now()) / 1000));
      const v = { d: Math.floor(t / 86400), h: Math.floor((t % 86400) / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
      for (const k of Object.keys(v)) if (parts[k]) parts[k].textContent = String(v[k]).padStart(k === 'd' ? 1 : 2, '0');
      if (t === 0) { const live = cd.querySelector('[data-cd-live]'); if (live) live.hidden = false; }
    };
    tick(); setInterval(tick, 1000);
  }
  const table = root.querySelector('[data-servers]');
  const every = Math.max(10, Number(root.getAttribute('data-refresh') || 30)) * 1000;
  async function refresh() {
    if (!table || document.hidden) return;
    try {
      const r = await fetch('/m/lan-intranet/status.json', { credentials: 'same-origin' });
      if (!r.ok) return;
      const { servers } = await r.json();
      for (const s of servers) {
        const row = table.querySelector(`[data-server="${s.id}"]`);
        if (!row) continue;
        const st = row.querySelector('[data-st]'), pl = row.querySelector('[data-pl]'), mp = row.querySelector('[data-map]');
        if (st) { st.className = 'srv-status ' + (s.status ? (s.status.online ? 'srv-up' : 'srv-down') : ''); st.lastElementChild.textContent = s.label; }
        if (pl) pl.textContent = s.players;
        if (mp) mp.textContent = s.map;
      }
    } catch { /* ignore */ }
  }
  setInterval(refresh, every);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
