/* site-track.js - remembers the client's bookings on THIS phone (after the first booking) and shows a "Track my service" button.
   Auto-injected by server.js on client pages. The client never types the mobile number again. */
(function () {
  var KEY = 'gth_bookings', PROF = 'gth_client';
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
  function put(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function add(id, phone, name) {
    phone = String(phone || '').replace(/\D/g, '').slice(-10); if (!id || phone.length !== 10) return;
    var l = load().filter(function (x) { return x.id !== id; }); l.push({ id: id, phone: phone, name: name || '', at: Date.now() }); put(KEY, l.slice(-20)); pill();
  }
  function remember(b) { if (b && b.phone) put(PROF, { name: b.name || '', phone: b.phone, address: b.address || '' }); }

  // watch successful bookings (home orders + medical bookings), without touching the page's own code
  var of = window.fetch;
  window.fetch = function (input, init) {
    var p = of.apply(this, arguments);
    try {
      var u = typeof input === 'string' ? input : (input && input.url) || '';
      if (init && String(init.method || '').toUpperCase() === 'POST' && typeof init.body === 'string' && /\/api\/(orders|medical-bookings)$/.test(u.split('?')[0])) {
        var body = JSON.parse(init.body);
        p.then(function (r) { if (r.status !== 201) return; r.clone().json().then(function (d) { if (d && d.id) { add(d.id, body.phone, body.name); remember(body); } }).catch(function () {}); }).catch(function () {});
      }
      // ambulance: /api/ambulance/start gives the booking id, /api/ambulance/confirm (after payment) makes it a real booking
      var path = u.split('?')[0];
      if (init && String(init.method || '').toUpperCase() === 'POST' && typeof init.body === 'string' && /\/api\/ambulance\/(start|confirm)$/.test(path)) {
        var ab = JSON.parse(init.body), isStart = /\/start$/.test(path);
        p.then(function (r) { if (!r.ok) return; r.clone().json().then(function (d) {
          var m = {}; try { m = JSON.parse(sessionStorage.getItem('gth_ambp') || '{}'); } catch (e) {}
          if (isStart) { if (d && d.id) { m[d.id] = { phone: ab.phone, name: ab.name, address: ab.address }; try { sessionStorage.setItem('gth_ambp', JSON.stringify(m)); } catch (e) {} } }
          else if (d && d.id && m[d.id]) { add(d.id, m[d.id].phone, m[d.id].name); remember(m[d.id]); }
        }).catch(function () {}); }).catch(function () {});
      }
    } catch (e) {}
    return p;
  };

  // pre-fill name / mobile / address on the next booking
  function prefill() {
    var pr; try { pr = JSON.parse(localStorage.getItem(PROF) || 'null'); } catch (e) { return; } if (!pr) return;
    ['name', 'phone', 'address'].forEach(function (k) {
      document.querySelectorAll('input[name="' + k + '"],textarea[name="' + k + '"]').forEach(function (el) {
        if (!el.value && pr[k]) { el.value = pr[k]; el.dispatchEvent(new Event('input', { bubbles: true })); }
      });
    });
  }

  function pill() {
    if (!load().length || document.getElementById('gthTrackPill')) return;
    var a = document.createElement('a'); a.id = 'gthTrackPill'; a.href = '/live.html'; a.textContent = '📍 Track my service';
    a.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:9999;background:#0e6e8c;color:#fff;padding:11px 16px;border-radius:26px;font:700 14px Segoe UI,Arial,sans-serif;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.3)';
    (document.body || document.documentElement).appendChild(a);
  }
  function init() { prefill(); pill(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
