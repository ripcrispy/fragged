// LAN tournaments: progressive enhancement only. Everything works without this script.
(() => {
  // Highlight an entry everywhere on the page (bracket, lists, standings) while hovering or focusing it.
  const hl = (id, on) => { if (!id) return; for (const el of document.querySelectorAll(`[data-entry="${CSS.escape(id)}"]`)) el.classList.toggle('is-hl', on); };
  for (const ev of [['mouseover', true], ['mouseout', false], ['focusin', true], ['focusout', false]]) {
    document.addEventListener(ev[0], (e) => { const el = e.target.closest && e.target.closest('[data-entry]'); if (el) hl(el.getAttribute('data-entry'), ev[1]); });
  }

  // Create/edit form: only show the settings that apply to the chosen format and player mode.
  const f = document.querySelector('[data-lt-form]');
  if (f) {
    const fmt = f.querySelector('select[name="format"]'), mode = f.querySelector('select[name="mode"]');
    const sync = () => {
      for (const el of f.querySelectorAll('[data-show-format]')) el.hidden = !el.getAttribute('data-show-format').split(' ').includes(fmt.value);
      for (const el of f.querySelectorAll('[data-show-mode]')) el.hidden = el.getAttribute('data-show-mode') !== mode.value;
    };
    fmt.addEventListener('change', sync); mode.addEventListener('change', sync); sync();
  }

  // Spectator view: refresh the board every 10 seconds and offer full screen for big displays.
  const spec = document.querySelector('[data-spectator]');
  if (spec) {
    const board = spec.querySelector('[data-board]'), stamp = spec.querySelector('[data-updated]'), url = spec.getAttribute('data-refresh');
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await fetch(url, { headers: { accept: 'text/html' }, credentials: 'same-origin' });
        if (r.ok) { board.innerHTML = await r.text(); if (stamp) stamp.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`; }
      } catch { /* keep the last board */ }
    };
    setInterval(tick, 10000);
    const fs = spec.querySelector('[data-fullscreen]');
    if (fs && document.fullscreenEnabled) {
      fs.hidden = false;
      fs.addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : spec.requestFullscreen()));
      document.addEventListener('fullscreenchange', () => { fs.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; });
    }
  }
})();
