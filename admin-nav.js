// Adds "Vendors & Tracking", "Air Operators & Charges" and "AMC Requests" links to the existing admin pages
(function () {
  if (!sessionStorage.getItem('adminKey') || document.getElementById('gth-vendors-link')) return;
  var lo = null;
  document.querySelectorAll('a,button').forEach(function (el) { if (!lo && /^\s*logout\s*$/i.test(el.textContent)) lo = el; });
  function mk(id, href, text) { var a = document.createElement('a'); a.id = id; a.href = href; a.textContent = text; return a; }
  var links = [mk('gth-vendors-link', '/admin-vendors.html', 'Vendors & Tracking')];
  if (!/admin-charges/.test(location.pathname)) links.push(mk('gth-charges-link', '/admin-charges.html', 'Air Operators & Charges'));
  if (!/amc-admin/.test(location.pathname)) links.push(mk('gth-amc-link', '/amc-admin.html#requests', 'AMC Requests'));
  if (lo) {
    var ref = lo.parentNode.querySelector('a') || lo;
    links.forEach(function (a) {
      a.className = ref.className; a.style.cssText = ref.getAttribute('style') || '';
      lo.parentNode.insertBefore(a, lo);
    });
  } else {
    links.forEach(function (a, i) {
      a.style.cssText = 'position:fixed;right:16px;bottom:' + (16 + i * 56) + 'px;background:#087cf2;color:#fff;padding:12px 20px;border-radius:99px;font:700 14px Segoe UI,sans-serif;text-decoration:none;box-shadow:0 6px 20px rgba(8,124,242,.35);z-index:9999';
      document.body.appendChild(a);
    });
  }
})();
