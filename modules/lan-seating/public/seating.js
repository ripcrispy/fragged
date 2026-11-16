// Live seat-map refresh while booking is open: re-fetch the server-rendered map every 15 s while the tab is visible.
(() => {
  const box = document.querySelector('[data-seatmap-live]');
  if (!box) return;
  const url = box.getAttribute('data-seatmap-live');
  async function refresh() {
    if (document.hidden) return;
    const focused = document.activeElement && box.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
    try {
      const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
      if (!r.ok) return;
      box.innerHTML = await r.text();
      if (focused) {
        const seat = focused.split(',')[0];
        const again = [...box.querySelectorAll('[aria-label]')].find((el) => el.getAttribute('aria-label').startsWith(seat + ','));
        if (again) again.focus();
      }
    } catch { /* offline: try again next tick */ }
  }
  setInterval(refresh, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
