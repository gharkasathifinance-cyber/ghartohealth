// Puts the Ghar to Health logo (logo.png) on every page automatically.
// To change the logo everywhere later, just replace public/logo.png.
(function () {
  var SRC = '/logo.png';
  function mk(h) {
    if (window.innerWidth < 480) h = Math.round(h * 0.85); // a little smaller on phones
    var i = document.createElement('img');
    i.src = SRC; i.alt = 'Ghar to Health';
    i.style.cssText = 'height:' + h + 'px;width:auto;display:block;flex:none;background:none;box-shadow:none;border-radius:0;margin:0';
    return i;
  }
  // 1) old blue "house icon" boxes (home page, footer, medical page)
  document.querySelectorAll('.logo-icon,.logo > i').forEach(function (el) {
    if (el.querySelector('img')) return;
    el.parentNode.replaceChild(mk(Math.max(el.offsetHeight || 40, 40) + 8), el);
  });
  // 2) brand text that starts with the house symbol (admin / vendor pages, headers)
  document.querySelectorAll('header *, nav *, [class*=logo], [class*=brand]').forEach(function (el) {
    if (el.children.length || el.closest('button,.btn') || !/^\s*\u2302/.test(el.textContent)) return;
    el.textContent = el.textContent.replace(/^\s*\u2302\s*/, '');
    el.style.display = 'inline-flex'; el.style.alignItems = 'center'; el.style.gap = '8px';
    el.insertBefore(mk(38), el.firstChild);
  });
  // 3) pages can ask for a big logo: <div data-site-logo data-h="64"></div>
  document.querySelectorAll('[data-site-logo]').forEach(function (el) {
    if (!el.firstChild) { var i = mk(+el.getAttribute('data-h') || 56); i.style.margin = '0 auto'; el.appendChild(i); }
  });
  // 4) browser-tab icon
  if (!document.querySelector('link[rel~=icon]')) {
    var l = document.createElement('link'); l.rel = 'icon'; l.href = SRC; document.head.appendChild(l);
  }
})();
