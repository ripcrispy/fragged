// Live order total on the pizza page (progressive enhancement; the server always recalculates).
(() => {
  for (const f of document.querySelectorAll('[data-pizza-order]')) {
    const out = f.querySelector('[data-pizza-total]');
    const cur = f.getAttribute('data-currency') || '';
    const update = () => {
      let cents = 0, n = 0;
      for (const i of f.querySelectorAll('input[data-price]')) {
        const q = Math.max(0, Math.min(10, Math.trunc(Number(i.value) || 0)));
        cents += q * Number(i.getAttribute('data-price')); n += q;
      }
      out.hidden = false;
      out.textContent = n ? `${n} item${n === 1 ? '' : 's'} · ${cur}${(cents / 100).toFixed(2)}` : 'Nothing selected yet';
    };
    f.addEventListener('input', update);
    update();
  }
})();
