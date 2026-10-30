/* login.js - shared customer login (phone + OTP) for any page.
   Same backend as the Services page: /api/auth/*  -> same GTHU id.
   Use:  GHTLogin.require(function(){ ...do the booking... });   */
(function () {
  if (window.GHTLogin) return;
  var css = '#ghtLd{margin:auto;border:none;border-radius:16px;width:min(420px,92vw);padding:0;max-height:92vh;overflow:auto;font-family:inherit}' +
    '#ghtLd::backdrop{background:rgba(7,57,110,.45)}#ghtLd form{padding:22px}' +
    '#ghtLd h3{margin:0;font-size:18px}#ghtLd p{font-size:13px;color:#5b7690;margin:4px 0 8px}' +
    '#ghtLd label{display:block;font-size:12px;font-weight:700;margin:10px 0 4px}' +
    '#ghtLd input{width:100%;box-sizing:border-box;padding:11px 12px;border:1.5px solid #cfe0ee;border-radius:10px;font:inherit;font-size:15px}' +
    '#ghtLd .row{display:flex;gap:10px;margin-top:14px}#ghtLd button{flex:1;padding:12px;border-radius:12px;font:inherit;font-weight:700;font-size:15px;cursor:pointer}' +
    '#ghtLd .sec{border:1px solid #087cf2;background:#fff;color:#087cf2}' +
    '#ghtLd .pri{border:none;background:linear-gradient(135deg,#087ff5,#0564cf);color:#fff}#ghtLd button:disabled{opacity:.6}' +
    '#ghtLd .m{font-size:13px;margin-top:10px;min-height:18px}#ghtLd .err{color:#c62828}#ghtLd .ok{color:#1b7f3b;font-weight:600}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var d = document.createElement('dialog'); d.id = 'ghtLd';
  d.innerHTML = '<form novalidate onsubmit="return false"><h3>Log in</h3>' +
    '<p>Please log in with your mobile number to continue your booking.</p>' +
    '<div id="ghtS1"><label>Full name (new users only)</label><input id="ghtName" autocomplete="name" placeholder="Your name">' +
    '<label>Mobile number</label><input id="ghtPhone" type="tel" inputmode="numeric" maxlength="10" placeholder="10-digit number">' +
    '<div class="row"><button type="button" class="sec" id="ghtCancel">Cancel</button><button type="button" class="pri" id="ghtSend">Send OTP</button></div></div>' +
    '<div id="ghtS2" style="display:none"><label>Enter OTP</label><input id="ghtOtp" inputmode="numeric" maxlength="6" placeholder="6-digit OTP">' +
    '<div class="row"><button type="button" class="sec" id="ghtBack">Back</button><button type="button" class="pri" id="ghtVerify">Verify</button></div></div>' +
    '<div class="m" id="ghtMsg" role="status"></div></form>';
  document.body.appendChild(d);
  var $ = function (i) { return document.getElementById(i); }, after = null, ph = '';
  function msg(t, bad) { var m = $('ghtMsg'); m.textContent = t; m.className = 'm ' + (bad ? 'err' : 'ok'); }
  function step(n) { $('ghtS1').style.display = n === 1 ? 'block' : 'none'; $('ghtS2').style.display = n === 2 ? 'block' : 'none'; }
  function post(u, b) { return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }); }
  function check() { return fetch('/api/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.ok; }).catch(function () { return false; }); }
  $('ghtSend').onclick = function () {
    ph = $('ghtPhone').value.replace(/\D/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(ph)) { msg('Please enter a valid 10-digit mobile number.', 1); return; }
    var b = $('ghtSend'); b.disabled = true; msg('Sending OTP...');
    post('/api/auth/send-otp', { name: $('ghtName').value, phone: ph }).then(function (x) {
      b.disabled = false;
      if (!x.ok) { msg(x.j.error || 'Could not send OTP.', 1); return; }
      step(2); $('ghtOtp').value = ''; msg('OTP sent. Please enter it within 5 minutes.'); $('ghtOtp').focus();
    }).catch(function () { b.disabled = false; msg('Cannot reach the server. Please try again.', 1); });
  };
  $('ghtVerify').onclick = function () {
    var otp = $('ghtOtp').value.replace(/\D/g, '');
    if (otp.length !== 6) { msg('Please enter the 6-digit OTP.', 1); return; }
    var b = $('ghtVerify'); b.disabled = true;
    post('/api/auth/verify-otp', { phone: ph, otp: otp }).then(function (x) {
      b.disabled = false;
      if (!x.ok) { msg(x.j.error || 'Verification failed.', 1); return; }
      d.close(); var fn = after; after = null; if (fn) fn();
    }).catch(function () { b.disabled = false; msg('Cannot reach the server. Please try again.', 1); });
  };
  $('ghtBack').onclick = function () { step(1); msg(''); };
  $('ghtCancel').onclick = function () { after = null; d.close(); };
  window.GHTLogin = {
    check: check,
    require: function (fn) { check().then(function (ok) { if (ok) fn(); else { after = fn; step(1); msg(''); d.showModal(); } }); }
  };
})();



/* ===== Customer ID badge: shows the logged-in GTHU ID on every page ===== */
(function () {
  var me = null;
  function fillUid() {
    if (!me) return;
    var want = '\u00B7 User ID: <b>' + me.userId + '</b>';
    document.querySelectorAll('.ght-uid').forEach(function (el) { if (el.innerHTML !== want) el.innerHTML = want; });
  }
  function badge() {
    fetch('/api/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (u) {
      if (document.getElementById('ghtBadge')) return;
      var el = document.createElement('div');
      el.id = 'ghtBadge';
      el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;background:#fff;border:1px solid #cfe0ee;border-radius:999px;padding:7px 14px;font:600 13px system-ui,sans-serif;color:#0a3a6b;box-shadow:0 4px 14px rgba(7,57,110,.15)';
      if (u && u.loggedIn) {
        me = u; fillUid();
        el.textContent = 'User ID: ' + u.userId + (u.name ? ' \u00B7 ' + u.name : '');
      } else {
        el.textContent = 'Not logged in \u00B7 Log in';
        el.style.cursor = 'pointer';
        el.onclick = function () { if (window.GHTLogin) GHTLogin.require(function () { location.reload(); }); };
      }
      document.body.appendChild(el);
    }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', badge); else badge();
  new MutationObserver(fillUid).observe(document.body, { childList: true, subtree: true });
})();
