'use strict';
// Applies the saved appearance (auto / light / dark) before the page paints.
(function () {
  let t = 'auto';
  try { t = localStorage.getItem('qm-theme') || 'auto'; } catch { /* storage unavailable */ }
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
})();
