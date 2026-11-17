// LAN Event Access: progressive enhancement only; every page works without this script.
(() => {
  // Approve form: the payment fields only matter for a new attendee.
  const f = document.querySelector('[data-lea-approve]');
  if (f) {
    const sel = f.querySelector('select[name="attendee"]');
    const box = f.querySelector('[data-lea-new]');
    const sync = () => { box.hidden = sel.value !== 'new'; };
    sel.addEventListener('change', sync); sync();
  }
  // Door desk: refresh the waiting list while nobody is typing or reading a dialog.
  const desk = document.querySelector('[data-lea-refresh]');
  if (desk) {
    const secs = Math.max(10, Number(desk.getAttribute('data-lea-refresh')) || 15);
    setInterval(() => {
      const a = document.activeElement;
      const busy = a && a !== document.body && a.closest('form, details[open]');
      if (document.visibilityState === 'visible' && !busy && !document.querySelector('details[open]')) location.reload();
    }, secs * 1000);
  }
})();
