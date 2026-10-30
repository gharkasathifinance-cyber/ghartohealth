/* Drop hospital: Google-powered suggestions for hospitals all over India.
   Finds the input under the label "Drop hospital name" automatically. */
(function () {
  var MIN = 3, DELAY = 300;
  var token = newToken();
  function newToken() { return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2); }

  var css = document.createElement('style');
  css.textContent =
    '.hac-wrap{position:relative}' +
    '.hac-list{position:absolute;left:0;right:0;top:100%;z-index:9999;margin-top:4px;background:#fff;border:1px solid #cfe0ee;border-radius:12px;box-shadow:0 8px 24px rgba(18,54,93,.18);max-height:300px;overflow-y:auto}' +
    '.hac-item{padding:12px 14px;cursor:pointer;border-bottom:1px solid #eef4f9;font-family:inherit}' +
    '.hac-item:last-child{border-bottom:0}' +
    '.hac-item.on,.hac-item:hover{background:#eef7ff}' +
    '.hac-name{font-weight:700;font-size:16px;color:#12365d}' +
    '.hac-detail{font-size:13px;color:#5b7893;margin-top:2px}' +
    '.hac-foot{padding:8px 14px;font-size:12px;color:#7a92a8}';
  document.head.appendChild(css);

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function findInput() {
    var labels = document.querySelectorAll('label');
    for (var i = 0; i < labels.length; i++) {
      if (/drop hospital name/i.test(labels[i].textContent)) {
        var inp = labels[i].control;
        if (!inp) {
          var n = labels[i].nextElementSibling;
          while (n && !/^(INPUT|TEXTAREA)$/.test(n.tagName)) n = n.nextElementSibling;
          inp = n;
        }
        if (inp && !inp.dataset.hac) return inp;
      }
    }
    return null;
  }

  function attach(inp) {
    inp.dataset.hac = '1';
    inp.setAttribute('autocomplete', 'off');
    if (!inp.placeholder) inp.placeholder = 'Type hospital name, e.g. Apollo Hospital Indore';

    var wrap = document.createElement('div');
    wrap.className = 'hac-wrap';
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    var list = document.createElement('div');
    list.className = 'hac-list';
    list.hidden = true;
    wrap.appendChild(list);

    var items = [], active = -1, timer = null, seq = 0, cache = {};   // cache: same text typed again = instant

    function close() { list.hidden = true; active = -1; }
    function pick(i) {
      if (!items[i]) return;
      inp.value = items[i].full;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      close();
      token = newToken(); // new billing session after a selection
    }
    function render() {
      if (!items.length) { close(); return; }
      list.innerHTML = items.map(function (it, i) {
        return '<div class="hac-item' + (i === active ? ' on' : '') + '" data-i="' + i + '"><div class="hac-name">🏥 ' + esc(it.name) + '</div><div class="hac-detail">' + esc(it.detail) + '</div></div>';
      }).join('') + '<div class="hac-foot">Not listed? Just type the full hospital name and city.</div>';
      list.hidden = false;
    }
    function search() {
      var q = inp.value.trim();
      if (q.length < MIN) { items = []; close(); return; }
      var my = ++seq, ck = q.toLowerCase();
      if (cache[ck]) { items = cache[ck]; active = -1; render(); return; }
      fetch('/api/hospital-search?q=' + encodeURIComponent(q) + '&t=' + encodeURIComponent(token))
        .then(function (r) { return r.json(); })
        .then(function (j) { if (my !== seq) return; items = j.items || []; cache[ck] = items; active = -1; render(); })
        .catch(function () { /* typing still works without suggestions */ });
    }

    inp.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(search, DELAY); });
    inp.addEventListener('keydown', function (e) {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', function (e) {
      var el = e.target.closest('.hac-item');
      if (el) { e.preventDefault(); pick(Number(el.dataset.i)); }
    });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); });
  }

  function scan() { var inp; while ((inp = findInput())) attach(inp); }
  scan();
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
})();
