/* Ambulance documents UI. Loaded after the vendor page script (uses its globals: V, ED, K, $, e, api, load, stats, drawV, shrink, ambPick, AN). */
(function () {
  // Same lists as the server (vendors.js). For an existing vendor the rows below come from the server, so this stays in step automatically.
  var AIR = [['aoc', 'DGCA Permit (AOC/NSOP)'], ['cor', 'Aircraft Registration Certificate'], ['coa', 'Airworthiness Certificate'], ['ins', 'Aircraft Insurance'], ['med', 'Medical Team Registration (Doctor / Paramedic)']];
  var REQ = {
    van: [['rc', 'Vehicle RC'], ['dl', 'Driver Licence'], ['ins', 'Vehicle Insurance'], ['fit', 'Fitness Certificate'], ['puc', 'PUC Certificate']],
    charter: AIR,
    heli: AIR,
    airline: [['reg', 'Doctor/Nurse Registration'], ['ins', 'Escort Insurance / ID Proof'], ['bls', 'BLS / ACLS Certificate']]
  };
  var SL = { verified: ['Verified', 'act'], pending: ['Pending', 'pend'], expired: ['Expired', 'un'], missing: ['Missing', 'sus'] };
  var st = document.createElement('style');
  st.textContent = '.adb{border:1px solid var(--l);border-radius:12px;padding:12px 14px;margin:0 0 12px;background:#fafdff}.adb h4{margin:0 0 8px}.dr{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;padding:7px 0;border-top:1px solid #edf3f9}.dr:first-of-type{border-top:0}.dr .dn{flex:1 1 190px;font-weight:600;font-size:14px}.dr input[type=file]{flex:1 1 190px;max-width:260px;padding:6px;font-size:13px}.dr input[type=date]{padding:7px 10px}.pend{background:#fff3cd;color:#8a6d00}.agr{display:block;font-size:14px;margin:0 0 14px;padding:10px 14px;background:#fff8e6;border:1px solid #f3dca0;border-radius:10px}.agr input{margin-right:8px}';
  document.head.appendChild(st);
  $('ambBox').insertAdjacentHTML('beforeend', '<div id="ambDocs"></div>');
  $('sb').insertAdjacentHTML('beforebegin', '<label class="agr" id="agrBox" hidden><input type="checkbox" id="agr">Vendor ne <b>Vendor Agreement</b> sign kar diya hai aur declaration di hai ki saare documents asli aur valid hain.</label>');

  function ymd() { return new Date(Date.now() + 19800000).toISOString().slice(0, 10); }
  function days(d) { return Math.round((new Date(d + 'T00:00:00Z') - new Date(ymd() + 'T00:00:00Z')) / 864e5); }
  function curV() { return ED ? V.filter(function (x) { return x.id === ED; })[0] : null; }
  function rows() { return [].slice.call(document.querySelectorAll('#ambDocs .adb:not([hidden]) .dr')); }
  function nm(r) { return r.querySelector('.dn').firstChild.textContent; }

  function sync() {
    var sel = ambPick(), off = $('ambBox').hidden;
    [].forEach.call(document.querySelectorAll('#ambDocs .adb'), function (b) { b.hidden = off || sel.indexOf(b.getAttribute('data-t')) < 0; });
    $('agrBox').hidden = off;
  }
  function sumLine(items) {   // one clear line: how many are verified and exactly which ones are left
    var ok = items.filter(function (x) { return x.d.state === 'verified'; }).length, rest = items.filter(function (x) { return x.d.state !== 'verified'; });
    if (!rest.length) return '<div class="sm" style="margin:0 0 8px;font-weight:700;color:#1b7a3a">&#10003; Sab ' + items.length + ' documents verified. Vendor is type ki bookings le sakta hai.</div>';
    return '<div class="sm" style="margin:0 0 8px;font-weight:700;color:#8a6d00">' + ok + ' / ' + items.length + ' verified. Baaki: ' +
      rest.map(function (x) { return e(x.r[1]) + ' (' + SL[x.d.state][0] + ')'; }).join(', ') + '. Jab tak saare verified nahi hote, vendor is type ki bookings nahi le sakta.</div>';
  }
  function build(v) {
    var h = '';
    Object.keys(REQ).forEach(function (t) {
      var cur = (v && v.amb && v.amb[t]) || [];
      var def = cur.length ? cur.map(function (x) { return [x.key, x.name]; }) : REQ[t];
      var items = def.map(function (r) { return { r: r, d: cur.filter(function (x) { return x.key === r[0]; })[0] || { state: 'missing', expiry: '', ext: '' } }; });
      h += '<div class="adb" data-t="' + t + '" hidden><h4>' + AN[t] + ' - documents</h4>' + (v ? sumLine(items) : '');
      items.forEach(function (it) {
        var r = it.r, d = it.d, s = SL[d.state];
        var warn = d.state === 'verified' && d.expiry && days(d.expiry) <= 30 ? ' <small style="color:#c2410c">(' + days(d.expiry) + ' din mein expire)</small>'
          : d.state === 'missing' ? ' <small style="color:#8a99a5">(file chuno, expiry date daalo, phir Update vendor)</small>' : '';
        h += '<div class="dr" data-t="' + t + '" data-k="' + r[0] + '" data-has="' + (d.ext ? 1 : '') + '" data-ex="' + e(d.expiry) + '"><span class="dn">' + e(r[1]) + warn + '</span><span class="tag ' + s[1] + '">' + s[0] + '</span><input type="file" class="df" accept="image/*,application/pdf"><input type="date" class="dx" value="' + e(d.expiry) + '" title="Expiry date">';
        if (d.ext) h += '<button type="button" class="btn" onclick="adoc(\'' + t + '\',\'' + r[0] + '\')">View</button>' + (d.state === 'verified' ? '<button type="button" class="btn r" onclick="averify(\'' + t + '\',\'' + r[0] + '\',false)">Unverify</button>' : d.state === 'pending' ? '<button type="button" class="btn g" onclick="averify(\'' + t + '\',\'' + r[0] + '\',true)">Verify</button>' : '');
        h += '</div>';
      });
      h += '</div>';
    });
    $('ambDocs').innerHTML = h;
    $('agr').checked = !!(v && v.agreement); $('agr').disabled = !!(v && v.agreement);
    sync();
  }
  function dirty() { return rows().some(function (r) { var x = r.querySelector('.dx').value; return r.querySelector('.df').files[0] || (x && x !== r.getAttribute('data-ex')); }); }
  function refresh() { return api('/api/admin/vendors').then(function (r) { if (Array.isArray(r)) { V = r; stats(); drawV(); var v = curV(); if (v) build(v); } }); }
  function fileData(f) {
    if (/pdf/i.test(f.type) || /\.pdf$/i.test(f.name)) return new Promise(function (ok, no) { var r = new FileReader(); r.onload = function () { ok(r.result); }; r.onerror = no; r.readAsDataURL(f); });
    return shrink(f);
  }

  window.ambDocCheck = function () {
    var t0 = ymd(), msg = '';
    rows().forEach(function (r) {
      if (msg) return;
      var f = r.querySelector('.df').files[0], x = r.querySelector('.dx').value;
      if (f) {
        if (!x) msg = nm(r) + ': expiry date daalo.';
        else if (x < t0) msg = nm(r) + ': expiry date purani hai.';
        else if ((/pdf/i.test(f.type) || /\.pdf$/i.test(f.name)) && f.size > 2.4e6) msg = nm(r) + ': PDF 2.4 MB se chhoti honi chahiye.';
      } else if (x && x !== r.getAttribute('data-ex')) {
        if (!r.getAttribute('data-has')) msg = nm(r) + ': pehle file chuno.';
        else if (x < t0) msg = nm(r) + ': expiry date purani hai.';
      }
    });
    return msg;
  };
  window.uploadAmbDocs = function (id) {
    var jobs = [];
    rows().forEach(function (r) { var f = r.querySelector('.df').files[0], x = r.querySelector('.dx').value; if (f || (x && x !== r.getAttribute('data-ex'))) jobs.push({ r: r, f: f, x: x }); });
    var p = Promise.resolve();
    jobs.forEach(function (j) {
      p = p.then(function () {
        return (j.f ? fileData(j.f) : Promise.resolve(undefined)).then(function (data) {
          var b = { id: id, type: j.r.getAttribute('data-t'), key: j.r.getAttribute('data-k'), expiry: j.x };
          if (data) b.file = data;
          return api('/api/admin/vendor-amb-doc', 'POST', b).then(function (res) { if (res.error) throw new Error(nm(j.r) + ': ' + res.error); });
        });
      });
    });
    return p.catch(function (err) { if (!ED) { ED = id; $('nid').value = id; } load(); throw err; });
  };
  window.adoc = function (t, k) {
    // PDFs open in a new tab (tab is opened right in the click so the browser does not block it); images open in the lightbox
    var it = (((curV() || {}).amb || {})[t] || []).filter(function (x) { return x.key === k; })[0];
    var w = it && it.ext === 'pdf' ? window.open('', '_blank') : null;
    fetch('/api/admin/vendor-doc?id=' + encodeURIComponent(ED) + '&type=' + t + '&key=' + k, { headers: { 'x-admin-key': K } })
      .then(function (r) { if (!r.ok) throw 0; return r.blob(); })
      .then(function (b) { var u = URL.createObjectURL(b); if (w) w.location = u; else if (b.type === 'application/pdf') window.open(u, '_blank'); else { $('lbi').src = u; $('lb').hidden = false; } })
      .catch(function () { if (w) w.close(); alert('File nahi mili'); });
  };
  window.averify = function (t, k, on) {
    if (dirty()) { alert('Pehle "Update vendor" dabake changes save karo, phir Verify/Unverify karo.'); return; }
    if (on && !confirm('Document dekh liya? Verify karne ke baad (agar is type ke saare documents verified hon) vendor is type ki bookings le sakega.')) return;
    api('/api/admin/vendor-amb-doc', 'POST', { id: ED, type: t, key: k, verify: on }).then(function (r) { if (r.error) { alert(r.error); return; } refresh(); });
  };
  window.ambSum = function (v) {
    if (v.services.indexOf('Ambulance') < 0) return '';
    var h = '';
    (v.ambTypes || []).forEach(function (t) {
      var d = (v.amb && v.amb[t]) || [], ok = d.filter(function (x) { return x.state === 'verified'; }).length, ex = d.some(function (x) { return x.state === 'expired'; });
      h += '<br><small>' + (AN[t] || t) + ': ' + (d.length && ok === d.length ? '<b style="color:#1b7a3a">Live &#10003;</b>' : '<b style="color:' + (ex ? '#c62828' : '#8a6d00') + '">' + ok + '/' + d.length + ' verified' + (ex ? ' (expired)' : '') + '</b>') + '</small>';
      var rest = d.filter(function (x) { return x.state !== 'verified'; });
      if (rest.length) h += '<br><small style="color:#8a6d00">Baaki: ' + rest.map(function (x) { return e(x.name) + ' (' + SL[x.state][0] + ')'; }).join(', ') + '</small>';
    });
    if (!v.agreement) h += '<br><small style="color:#c62828">Agreement not signed</small>';
    return h;
  };

  // Ambulance operators are added on the "Ambulance Operators & Charges" page (admin-charges.html), together with their documents.
  // So the Ambulance service is hidden when adding a new professional; it stays visible only when editing an existing ambulance vendor.
  function ambChip(show) { var i = document.querySelector('#sv input[value="Ambulance"]'); if (i) { var l = i.closest('label') || i.parentNode; l.style.display = show ? '' : 'none'; } }
  var _o = window.openF; window.openF = function () { _o(); build(null); ambChip(false); };
  var _e = window.edit; window.edit = function (i) { _e(i); build(V[i]); ambChip(V[i].services.indexOf('Ambulance') > -1); };
  $('sv').addEventListener('change', sync);
  $('ambt').addEventListener('change', sync);
  build(null);
})();
