// Ghar to Health - Ambulance vendor documents patch
// Run from the project folder:   node patch_ambulance_docs.js
// Undo:                          node patch_ambulance_docs.js --undo
// Safe: backs up first, checks every edit point, checks syntax, and writes NOTHING if anything looks wrong.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.cwd(), PUB = path.join(ROOT, 'public');
const VENDORS = path.join(ROOT, 'vendors.js'), CLIENT_JS = path.join(PUB, 'amb-docs.js');
const STAMP = path.join(ROOT, '_backup_ambulance_latest.txt');
const die = m => { console.log('\nRUKA GAYA (kuch change nahi hua): ' + m + '\n'); process.exit(1); };

// ---------- undo ----------
if (process.argv.includes('--undo')) {
  let dir; try { dir = fs.readFileSync(STAMP, 'utf8').trim(); } catch { die('Koi backup nahi mila.'); }
  const full = path.join(ROOT, dir);
  fs.readdirSync(full).forEach(f => {
    const rel = f.replace(/^pub__/, 'public' + path.sep);
    fs.copyFileSync(path.join(full, f), path.join(ROOT, rel));
  });
  try { fs.unlinkSync(CLIENT_JS); } catch {}
  console.log('Wapas purani files restore ho gayi (' + dir + '). Server restart karo.'); process.exit(0);
}

// ---------- helpers ----------
function load(file) { const raw = fs.readFileSync(file, 'utf8'); return { crlf: raw.includes('\r\n'), s: raw.replace(/\r\n/g, '\n') }; }
function apply(doc, edits, label) {
  let s = doc.s;
  for (const [from, to, name] of edits) {
    const n = s.split(from).length - 1;
    if (n !== 1) die(label + ': "' + name + '" wali line ' + (n === 0 ? 'nahi mili' : 'kai baar mili') + '. File shayad alag version ki hai - mujhe bhej do.');
    s = s.replace(from, () => to);
  }
  return doc.crlf ? s.replace(/\n/g, '\r\n') : s;
}
function syntax(code, name) { try { new vm.Script(code, { filename: name }); } catch (e) { die('Syntax check fail (' + name + '): ' + e.message); } }

// ---------- find the vendor admin page ----------
if (!fs.existsSync(VENDORS)) die('vendors.js is folder mein nahi hai. Project folder (jahan server.js hai) mein chalao.');
let page = null;
{
  const hits = fs.readdirSync(PUB).filter(f => /\.html$/i.test(f) && fs.readFileSync(path.join(PUB, f), 'utf8').includes('Services this vendor provides'));
  if (hits.length !== 1) die('Vendor form wali HTML file ' + (hits.length ? 'kai mili: ' + hits.join(', ') : 'nahi mili') + '.');
  page = path.join(PUB, hits[0]);
}
const vsrc = load(VENDORS), psrc = load(page);
if (vsrc.s.includes('ambDocs') || psrc.s.includes('amb-docs.js')) die('Ye patch pehle se lag chuka hai.');

// ---------- 1. vendors.js (server) ----------
const HELPERS = String.raw`const ambErr = 'Ambulance vendor ke liye type chuno (Road / Charter / Commercial Airline / Helicopter).';
  // ---- Ambulance documents: type-wise, with expiry date + admin verification ----
  const REQ = {
    van: [['rc', 'Vehicle RC'], ['dl', 'Driver Licence'], ['ins', 'Vehicle Insurance']],
    charter: [['aoc', 'DGCA Permit (AOC/NSOP)'], ['coa', 'Airworthiness Certificate'], ['ins', 'Aircraft Insurance']],
    heli: [['aoc', 'DGCA Permit (AOC/NSOP)'], ['coa', 'Airworthiness Certificate'], ['ins', 'Aircraft Insurance']],
    airline: [['reg', 'Doctor/Nurse Registration'], ['ins', 'Escort Insurance / ID Proof']]
  };
  const today = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10); // India date
  function docState(d) { // missing | pending | verified | expired
    if (!d) return 'missing';
    if (d.expiry && d.expiry < today()) return 'expired';
    return d.status === 'verified' && d.expiry ? 'verified' : 'pending';
  }
  const ambReady = (v, t) => !!REQ[t] && REQ[t].every(r => docState(((v.ambDocs || {})[t] || {})[r[0]]) === 'verified');
  // vendor may take an ambulance job of type t only if all its documents for t are Verified and not expired
  const ambOk = (v, t) => { const ts = v.ambTypes || []; return t ? ts.includes(t) && ambReady(v, t) : ts.some(x => ambReady(v, x)); };
  function ambView(v) {
    const o = {};
    (v.ambTypes || []).forEach(t => { o[t] = (REQ[t] || []).map(r => { const d = ((v.ambDocs || {})[t] || {})[r[0]]; return { key: r[0], name: r[1], state: docState(d), expiry: (d && d.expiry) || '', ext: d ? d.ext : '' }; }); });
    return o;
  }
  function saveAmbDoc(id, t, k, u) {
    const m = /^data:(image\/jpeg|image\/png|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(u || ''));
    if (!m) return null;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 500 || buf.length > 2.5e6) return null;
    const ok = m[1] === 'application/pdf' ? buf.slice(0, 4).toString() === '%PDF' : m[1] === 'image/jpeg' ? buf[0] === 0xFF && buf[1] === 0xD8 : buf[0] === 0x89 && buf[1] === 0x50;
    if (!ok) return null;
    const ext = m[1] === 'application/pdf' ? 'pdf' : m[1] === 'image/jpeg' ? 'jpg' : 'png';
    fs.mkdirSync(DOCS, { recursive: true });
    ['jpg', 'png', 'pdf'].forEach(e => { try { fs.unlinkSync(path.join(DOCS, id + '-' + t + '-' + k + '.' + e)); } catch {} });
    fs.writeFileSync(path.join(DOCS, id + '-' + t + '-' + k + '.' + ext), buf); return ext;
  }
  // Runs at start, every hour and after every document change: waiting (not yet accepted) ambulance
  // bookings of a vendor whose documents expired / are unverified move to another eligible vendor, or become Unassigned.
  function sweep() {
    const vs = rd(), list = c.readBookings(); let n = 0;
    list.forEach(x => {
      if (x.service !== 'Ambulance' || !x.vendorId || x.vendorStatus !== 'assigned' || x.status === 'cancelled') return;
      const v = vs.find(y => y.id === x.vendorId);
      if (v && ambOk(v, ambOf(x))) return;
      const nm = x.vendorName || x.vendorId;
      Object.assign(x, { vendorId: '', vendorName: '', vendorStatus: '', partnerName: '', status: 'new' });
      log(x, nm + ' ke documents valid/verified nahi - booking released'); assign(x, list); n++;
    });
    if (n) c.saveBookings(list);
    return n;
  }`;

const ENDPOINT = String.raw`if (p === '/api/admin/vendor-amb-doc' && POST) {
      const b = await body(), l = rd(), v = l.find(x => x.id === b.id), t = String(b.type || ''), k = String(b.key || '');
      if (!v) return done(404, { error: 'Vendor not found' });
      if (!REQ[t] || !REQ[t].some(r => r[0] === k)) return done(400, { error: 'Invalid document.' });
      v.ambDocs = v.ambDocs || {}; v.ambDocs[t] = v.ambDocs[t] || {};
      const set = v.ambDocs[t], old = set[k];
      const ex = b.expiry === undefined ? undefined : String(b.expiry);
      if (ex !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(ex) || ex < today())) return done(400, { error: 'Valid expiry date daalo (aaj ya aage ki date).' });
      if (b.file && !ex && !(old && old.expiry)) return done(400, { error: 'Expiry date daalo.' });
      let d = old;
      if (b.file) {
        const e = saveAmbDoc(v.id, t, k, b.file);
        if (!e) return done(400, { error: 'File JPG, PNG ya PDF honi chahiye (max 2.5 MB).' });
        d = set[k] = { ext: e, expiry: ex || (old && old.expiry) || '', status: 'pending', at: now() };
      } else if (!d) return done(400, { error: 'Pehle file upload karo.' });
      else if (ex !== undefined && ex !== d.expiry) { d.expiry = ex; d.status = 'pending'; }
      if (typeof b.verify === 'boolean') {
        if (b.verify && (!d.expiry || d.expiry < today())) return done(400, { error: 'Verify karne se pehle valid expiry date zaroori hai.' });
        d.status = b.verify ? 'verified' : 'pending'; d.verifiedAt = b.verify ? now() : undefined;
      }
      wr(l); sweep(); return done(200, { ok: true });
    }
    if (p === '/api/admin/auto-assign' && POST) {`;

const DOCVIEW = String.raw`if (p === '/api/admin/vendor-doc' && url.searchParams.get('key')) {
      const id = c.clean(url.searchParams.get('id'), 20), t = url.searchParams.get('type'), k = url.searchParams.get('key');
      const v = rd().find(x => x.id === id), d = v && v.ambDocs && v.ambDocs[t] && v.ambDocs[t][k];
      if (!d) return done(404, { error: 'No document' });
      try { c.send(res, 200, fs.readFileSync(path.join(DOCS, id + '-' + t + '-' + k + '.' + d.ext)), { 'Content-Type': d.ext === 'pdf' ? 'application/pdf' : d.ext === 'png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store' }); return true; }
      catch { return done(404, { error: 'File missing' }); }
    }
    if (p === '/api/admin/vendor-doc') {`;

const vEdits = [
  ["const ambErr = 'Ambulance vendor ke liye type chuno (Road / Charter / Commercial Airline / Helicopter).';", HELPERS, 'ambErr'],
  ["(k !== 'Ambulance' || !ambOf(b) || (v.ambTypes || []).includes(ambOf(b)))", "(k !== 'Ambulance' || ambOk(v, ambOf(b)))", 'assign filter'],
  ["if (b.action === 'accept' && x.vendorStatus === 'assigned') {",
    "if (b.action === 'accept' && x.vendorStatus === 'assigned' && x.service === 'Ambulance' && !ambOk(v, ambOf(x))) return done(403, { error: 'Aapke ambulance documents valid/verified nahi hain. Admin se baat karein.' });\n      if (b.action === 'accept' && x.vendorStatus === 'assigned') {", 'vendor accept'],
  ["ambTypes: v.ambTypes || [], active: v.active, topic: v.topic,", "ambTypes: v.ambTypes || [], amb: ambView(v), agreement: !!(v.agreement && v.agreement.signed), active: v.active, topic: v.topic,", 'vendor list'],
  ["if (p === '/api/admin/vendor-doc') {", DOCVIEW, 'doc view'],
  ["if (services.includes('Ambulance') && !ambTypes.length) return done(400, { error: ambErr });",
    "if (services.includes('Ambulance') && !ambTypes.length) return done(400, { error: ambErr });\n      if (services.includes('Ambulance') && b.agreement !== true) return done(400, { error: 'Vendor Agreement sign hone ka tick lagao.' });", 'add: agreement'],
  ["docs: { aadhaar: a, pan: pn }, topic:", "docs: { aadhaar: a, pan: pn }, agreement: b.agreement === true ? { signed: true, at: now() } : undefined, topic:", 'add: store agreement'],
  ["if (b.location) v.location = c.clean(b.location, 150);", "if (b.location) v.location = c.clean(b.location, 150);\n      if (b.agreement === true && !(v.agreement && v.agreement.signed)) v.agreement = { signed: true, at: now() };", 'edit: agreement'],
  ["['aadhaar', 'pan'].forEach(t => { const e = v.docs && v.docs[t]; if (e) { try { fs.renameSync(path.join(DOCS, old + '-' + t + '.' + e), path.join(DOCS, nid + '-' + t + '.' + e)); } catch {} } });",
    "try { fs.readdirSync(DOCS).filter(f => f.startsWith(old + '-')).forEach(f => { try { fs.renameSync(path.join(DOCS, f), path.join(DOCS, nid + f.slice(old.length))); } catch {} }); } catch {}", 'rename docs'],
  ["wr(l); if (was && !v.active) release(v, ' suspended');", "wr(l); if (was && !v.active) release(v, ' suspended'); sweep();", 'edit: sweep'],
  ["const delDocs = id => { delDoc(id, 'aadhaar'); delDoc(id, 'pan'); };",
    "const delDocs = id => { try { fs.readdirSync(DOCS).filter(f => f.startsWith(id + '-')).forEach(f => { try { fs.unlinkSync(path.join(DOCS, f)); } catch {} }); } catch {} };", 'delete docs'],
  ["if (v && x.service === 'Ambulance' && ambOf(x) && !(v.ambTypes || []).includes(ambOf(x))) return done(400, { error: 'Ye vendor is ambulance type ka nahi hai. Same type ka vendor chuno.' });",
    "if (v && x.service === 'Ambulance' && ambOf(x) && !(v.ambTypes || []).includes(ambOf(x))) return done(400, { error: 'Ye vendor is ambulance type ka nahi hai. Same type ka vendor chuno.' });\n      if (v && x.service === 'Ambulance' && !ambOk(v, ambOf(x))) return done(400, { error: 'Is vendor ke ambulance documents Verified aur valid nahi hain. Pehle documents verify karo.' });", 'manual assign'],
  ["if (p === '/api/admin/auto-assign' && POST) {", ENDPOINT, 'new endpoint'],
  ["return { handle, assign };", "sweep(); setInterval(sweep, 3600e3).unref();\n  return { handle, assign, sweep };", 'module end']
];

// ---------- 2. vendor admin page (HTML) ----------
const pEdits = [
  ["+k('aadhaar','Aadhaar')+'<br>'+k('pan','PAN')+'</td>", "+k('aadhaar','Aadhaar')+'<br>'+k('pan','PAN')+(typeof ambSum==='function'?ambSum(v):'')+'</td>", 'documents column'],
  ["ambTypes:ambPick(),aadhaar:d[0],pan:d[1]};", "ambTypes:ambPick(),agreement:!!$('agr').checked,aadhaar:d[0],pan:d[1]};", 'save: agreement'],
  ["throw new Error('Ambulance ka type chuno: Road / Charter / Commercial Airline / Helicopter.');",
    "throw new Error('Ambulance ka type chuno: Road / Charter / Commercial Airline / Helicopter.');\n  if(b.services.indexOf('Ambulance')>-1){if(!b.agreement)throw new Error('Vendor Agreement sign hone ka tick lagao.');var ae=ambDocCheck();if(ae)throw new Error(ae)}", 'save: checks'],
  ["closeF();load()})", "return uploadAmbDocs(r.id||b.id).then(function(){closeF();load()})})", 'save: upload'],
  ["</script></body></html>", '</script><script src="amb-docs.js"></script></body></html>', 'page end']
];

// ---------- 3. new browser script (public/amb-docs.js) ----------
const CLIENT = String.raw`/* Ambulance documents UI. Loaded after the vendor page script (uses its globals: V, ED, K, $, e, api, load, stats, drawV, shrink, ambPick, AN). */
(function () {
  var REQ = {
    van: [['rc', 'Vehicle RC'], ['dl', 'Driver Licence'], ['ins', 'Vehicle Insurance']],
    charter: [['aoc', 'DGCA Permit (AOC/NSOP)'], ['coa', 'Airworthiness Certificate'], ['ins', 'Aircraft Insurance']],
    heli: [['aoc', 'DGCA Permit (AOC/NSOP)'], ['coa', 'Airworthiness Certificate'], ['ins', 'Aircraft Insurance']],
    airline: [['reg', 'Doctor/Nurse Registration'], ['ins', 'Escort Insurance / ID Proof']]
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
  function build(v) {
    var h = '';
    Object.keys(REQ).forEach(function (t) {
      var cur = (v && v.amb && v.amb[t]) || [];
      h += '<div class="adb" data-t="' + t + '" hidden><h4>' + AN[t] + ' - documents</h4>';
      REQ[t].forEach(function (r) {
        var d = cur.filter(function (x) { return x.key === r[0]; })[0] || { state: 'missing', expiry: '', ext: '' }, s = SL[d.state];
        var warn = d.state === 'verified' && d.expiry && days(d.expiry) <= 30 ? ' <small style="color:#c2410c">(' + days(d.expiry) + ' din mein expire)</small>' : '';
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
    });
    if (!v.agreement) h += '<br><small style="color:#c62828">Agreement not signed</small>';
    return h;
  };

  var _o = window.openF; window.openF = function () { _o(); build(null); };
  var _e = window.edit; window.edit = function (i) { _e(i); build(V[i]); };
  $('sv').addEventListener('change', sync);
  $('ambt').addEventListener('change', sync);
  build(null);
})();
`;

// ---------- build in memory, check, then write ----------
const newVendors = apply(vsrc, vEdits, 'vendors.js');
const newPage = apply(psrc, pEdits, path.basename(page));
syntax(newVendors, 'vendors.js');
syntax(CLIENT, 'amb-docs.js');
{ // syntax of the page's inline script
  const m = [...newPage.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!m.length) die('Page ke andar script nahi mila.');
  syntax(m[m.length - 1][1], path.basename(page) + ' (inline script)');
}

const stamp = '_backup_ambulance_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const bdir = path.join(ROOT, stamp); fs.mkdirSync(bdir);
fs.copyFileSync(VENDORS, path.join(bdir, 'vendors.js'));
fs.copyFileSync(page, path.join(bdir, 'pub__' + path.basename(page)));
fs.writeFileSync(STAMP, stamp);
fs.writeFileSync(VENDORS, newVendors);
fs.writeFileSync(page, newPage);
fs.writeFileSync(CLIENT_JS, CLIENT);
console.log('\nHO GAYA.\n  Backup: ' + stamp + '\n  Patched: vendors.js, public/' + path.basename(page) + ', public/amb-docs.js (new)\n\nAb server band karke dobara chalao:  node server.js\nWapas jaane ke liye:  node patch_ambulance_docs.js --undo\n');
