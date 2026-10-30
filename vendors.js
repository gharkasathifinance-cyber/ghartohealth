// Vendor module for Ghar to Health. Put this file next to server.js
const fs = require('fs'), path = require('path'), crypto = require('crypto');
module.exports = function (c) {
  const D = path.join(__dirname, 'data'), FILE = path.join(D, 'vendors.json'), SECF = path.join(D, 'secret.txt'), DOCS = path.join(D, 'vendor-docs');
  const rd = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };
  const wr = l => { fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(l, null, 2)); };
  // ---- Self-enrolment: applications wait here until the admin approves them ----
  const APPF = path.join(D, 'vendor-applications.json');
  const rdA = () => { try { return JSON.parse(fs.readFileSync(APPF, 'utf8')); } catch { return []; } };
  const wrA = l => { fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(APPF, JSON.stringify(l, null, 2)); };
  const applyHits = new Map();   // ip -> timestamps (rate limit)
  const mailer = require('./mailer');
  const AMB_NAME = { van: 'Road ambulance', charter: 'Charter aircraft', heli: 'Helicopter', airline: 'Commercial airline' };
  // Sequential partner numbers: GTHH0001, GTHH0002 ... (home) and GTHM0001 ... (medical). Used as the login ID.
  const SEQF = path.join(D, 'vendor-seq.json');
  function nextNo(section) {
    let q = {}; try { q = JSON.parse(fs.readFileSync(SEQF, 'utf8')); } catch {}
    const k = ['medical', 'ambulance'].includes(section) ? section : 'home', pre = { home: 'GTHH', medical: 'GTHM', ambulance: 'GTHA' }[k];
    const used = [...rd(), ...rdA()].map(x => x.id.toUpperCase());
    let n = q[k] || 0, id; do { n++; id = pre + String(n).padStart(4, '0'); } while (used.includes(id));
    q[k] = n; fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(SEQF, JSON.stringify(q)); return id;
  }
  let SECRET;
  try { SECRET = fs.readFileSync(SECF, 'utf8'); } catch { SECRET = crypto.randomBytes(32).toString('hex'); fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(SECF, SECRET); }
  const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
  const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const mkToken = id => { const e = Date.now() + 12 * 3600e3; return id + '.' + e + '.' + sign(id + '.' + e); };
  const phoneOk = s => /^(\+91)?[6-9]\d{9}$/.test(s);
  function auth(req) { // every request re-reads the vendor file, so Suspend/Delete work instantly
    const t = (req.headers.authorization || '').replace('Bearer ', '').split('.');
    if (t.length !== 3 || +t[1] < Date.now() || !same(sign(t[0] + '.' + t[1]), t[2])) return null;
    const v = rd().find(x => x.id === t[0]); return v && v.active ? v : null;
  }
  // Aadhaar / PAN photos live in data/vendor-docs (NOT in public/), only admin can view them
  function saveDoc(id, type, u) {
    const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(u || ''));
    if (!m) return null;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 3000 || buf.length > 2.5e6) return null;
    if (!(m[1] === 'jpeg' ? buf[0] === 0xFF && buf[1] === 0xD8 : buf[0] === 0x89 && buf[1] === 0x50)) return null;
    const ext = m[1] === 'jpeg' ? 'jpg' : 'png';
    fs.mkdirSync(DOCS, { recursive: true }); delDoc(id, type);
    fs.writeFileSync(path.join(DOCS, id + '-' + type + '.' + ext), buf); return ext;
  }
  const delDoc = (id, t) => ['jpg', 'png'].forEach(e => { try { fs.unlinkSync(path.join(DOCS, id + '-' + t + '.' + e)); } catch {} });
  const delDocs = id => { try { fs.readdirSync(DOCS).filter(f => f.startsWith(id + '-')).forEach(f => { try { fs.unlinkSync(path.join(DOCS, f)); } catch {} }); } catch {} };
  function ping(v, b) { // no customer details in the alert
    fetch('https://ntfy.sh/' + v.topic, { method: 'POST', headers: { Title: 'New request from Ghar to Health', Priority: 'urgent', Tags: 'bell,rotating_light' }, body: 'New ' + String(b.service || 'service').replace(/[^\x20-\x7E]/g, '') + ' request (' + b.id + '). Open your partner panel to accept it.' }).catch(() => {});
  }
  const now = () => new Date().toISOString();
  const log = (b, ev) => (b.history = b.history || []).push({ at: now(), event: ev });
  const AMB = ['van', 'charter', 'airline', 'heli']; // Road, Charter aircraft, Commercial airline, Helicopter
  function ambOf(b) { // which ambulance type a booking needs (old bookings are guessed from the item name)
    if (b.ambType) return b.ambType;
    if (b.service !== 'Ambulance') return '';
    const t = String(b.item || '');
    return /charter/i.test(t) ? 'charter' : /commercial|airline/i.test(t) ? 'airline' : /helicopter/i.test(t) ? 'heli' : /road|van/i.test(t) ? 'van' : '';
  }
  const ambClean = a => [...new Set((Array.isArray(a) ? a : []).filter(t => AMB.includes(t)))];
  const ambErr = 'Select the ambulance vendor type (Road / Charter / Commercial Airline / Helicopter).';
  // ---- Ambulance documents: type-wise, with expiry date + admin verification ----
  const AIR_DOCS = [['aoc', 'DGCA Permit (AOC/NSOP)'], ['cor', 'Aircraft Registration Certificate'], ['coa', 'Airworthiness Certificate'], ['ins', 'Aircraft Insurance'], ['med', 'Medical Team Registration (Doctor / Paramedic)']];
  const REQ = {
    van: [['rc', 'Vehicle RC'], ['dl', 'Driver Licence'], ['ins', 'Vehicle Insurance'], ['fit', 'Fitness Certificate'], ['puc', 'PUC Certificate']],
    charter: AIR_DOCS,
    heli: AIR_DOCS,
    airline: [['reg', 'Doctor/Nurse Registration'], ['ins', 'Escort Insurance / ID Proof'], ['bls', 'BLS / ACLS Certificate']]
  };
  // ---- Professional details (everything except Ambulance, which has its own documents above) ----
  const MED_KIND = { 'Doctor Consultation': 'doctor', 'Dental Care': 'doctor', 'Eye Care': 'doctor', 'Mental Health': 'doctor', 'Nurse at Home': 'nurse', 'Physiotherapy': 'physio', 'Diet & Nutrition': 'diet', 'Lab Tests': 'lab', 'Health Check-up': 'lab', 'Scans & Imaging': 'lab', 'Medicine Delivery': 'pharmacy' };
  const PRO = { f: ['qualification', 'regNo', 'council'], d: ['cert', 'reg'] }, ORG = { f: ['orgName', 'licenceNo', 'responsibleName', 'responsibleReg'], d: ['reg'] };
  const KIND_REQ = { doctor: PRO, nurse: PRO, physio: PRO, diet: { f: ['qualification'], d: ['cert'] }, lab: ORG, pharmacy: ORG };
  const FL = { qualification: 'Qualification / degree', regNo: 'Registration number', council: 'Name of the council', orgName: 'Lab / pharmacy / centre name', licenceNo: 'Licence / registration number', responsibleName: 'Name of the pathologist / radiologist / pharmacist', responsibleReg: 'Their registration number' };
  const DL = { cert: 'Degree / certificate photo', reg: 'Registration / licence photo' };
  const kindsOf = (svcs, section) => {
    const na = (svcs || []).filter(x => x !== 'Ambulance'), ks = [...new Set(na.map(x => MED_KIND[x]).filter(Boolean))];
    if (!ks.length && section === 'medical' && na.length) ks.push('doctor');
    return ks;
  };
  const needOf = ks => ({ f: [...new Set(ks.flatMap(k => KIND_REQ[k].f))], d: [...new Set(ks.flatMap(k => KIND_REQ[k].d))] });
  const PKEYS = ['email', 'experience', 'qualification', 'regNo', 'council', 'orgName', 'licenceNo', 'responsibleName', 'responsibleReg', 'gstin', 'upi', 'bank', 'aadhaarNo', 'panNo'];
  function profIn(b) {
    const p = b.prof && typeof b.prof === 'object' ? b.prof : {}, o = {};
    PKEYS.forEach(k => { o[k] = c.clean(p[k], k === 'bank' ? 200 : k === 'email' ? 80 : 100).trim(); });
    o.email = o.email.toLowerCase(); o.gstin = o.gstin.toUpperCase().slice(0, 15); o.experience = o.experience.replace(/\D/g, '').slice(0, 2);
    o.aadhaarNo = o.aadhaarNo.replace(/\D/g, '').slice(0, 12); o.panNo = o.panNo.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    return o;
  }
  function profErr(p, kinds, creating) {
    if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(p.email)) return 'Enter a valid email address.';
    if (p.upi && !/^[\w.\-]{2,}@[A-Za-z]{2,}$/.test(p.upi)) return 'Enter a valid UPI ID (name@bank).';
    if (p.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(p.gstin)) return 'Enter a valid GSTIN or leave it blank.';
    if (p.aadhaarNo && !/^\d{12}$/.test(p.aadhaarNo)) return 'Enter a valid 12-digit Aadhaar number.';
    if (p.panNo && !/^[A-Z]{5}\d{4}[A-Z]$/.test(p.panNo)) return 'Enter a valid PAN number (for example ABCDE1234F).';
    if (!creating) return '';
    if (!p.email) return 'Enter the vendor\'s email address.';
    if (!kinds.length) return '';   // home maintenance: keep it simple
    if (p.experience === '') return 'Enter the vendor\'s experience in years.';
    for (const k of needOf(kinds).f) if (!p[k]) return 'Enter: ' + FL[k] + '.';
    return '';
  }
  function profComplete(v) {
    const ks = kindsOf(v.services, v.section); if (!ks.length) return true;
    const p = v.prof, n = needOf(ks); if (!p) return false;
    return !!(p.email && p.experience !== '' && p.experience != null && p.declaration && p.declaration.signed
      && n.f.every(k => p[k]) && n.d.every(t => v.docs && v.docs[t]));
  }
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
      log(x, nm + "'s documents are not valid or verified - booking released"); assign(x, list); n++;
    });
    if (n) c.saveBookings(list);
    return n;
  }
  function keyOf(b) { // orders store an item list, so use the category of the first item
    if (b.type === 'order' && b.items && b.items[0]) { const s = (c.readCatalog() || []).find(x => x.id === b.items[0].id); if (s) return s.category; }
    return b.service;
  }
  function assign(b, list, key) { // active vendor for this service with the fewest open jobs
    const k = key || keyOf(b), cands = rd().filter(v => v.active && v.services.includes(k) && (k !== 'Ambulance' || ambOk(v, ambOf(b))));
    if (!cands.length) return false;
    const load = v => list.filter(x => x.vendorId === v.id && x.vendorStatus !== 'done' && x.status !== 'cancelled').length;
    cands.sort((a, z) => load(a) - load(z));
    const v = cands[0];
    Object.assign(b, { vendorId: v.id, vendorName: v.name, vendorStatus: 'assigned' });
    log(b, 'Assigned to ' + v.name); ping(v, b); return true;
  }
  function release(v, why) { // open bookings go to another vendor, or become Unassigned
    const list = c.readBookings();
    list.forEach(x => {
      if (x.vendorId === v.id && x.vendorStatus !== 'done' && x.status !== 'cancelled') {
        Object.assign(x, { vendorId: '', vendorName: '', vendorStatus: '', partnerName: '', status: 'new' });
        log(x, v.name + why + ' - booking released'); assign(x, list);
      }
    });
    c.saveBookings(list);
  }
  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/api/vendor') && !p.startsWith('/api/admin/vendor') && p !== '/api/admin/assign' && p !== '/api/admin/auto-assign') return false;
    const done = (s, o) => { c.send(res, s, o); return true; };
    const body = async () => { try { return await c.readBody(req, 4e6); } catch { return {}; } };
    const POST = req.method === 'POST';

    if (p === '/api/vendor/login' && POST) {
      const b = await body(), v = rd().find(x => x.id.toLowerCase() === c.clean(b.id, 30).toLowerCase());
      if (!v) {   // not a vendor yet: maybe an application that is still waiting or was declined
        const a = rdA().find(x => x.id.toLowerCase() === c.clean(b.id, 30).toLowerCase());
        if (a && same(hash(String(b.password || ''), a.salt), a.hash)) return done(403, { error: a.status === 'rejected' ? 'Your application was not approved.' + (a.note ? ' Reason: ' + a.note : '') : 'Your application is under review. You can log in once it is approved.' });
      }
      if (!v || !v.active || !same(hash(String(b.password || ''), v.salt), v.hash)) return done(401, { error: 'Wrong ID/password, or account suspended.' });
      return done(200, { token: mkToken(v.id), name: v.name });
    }
    if (p === '/api/vendor/apply' && POST) {   // public: a partner applies by themselves (needs admin approval)
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), t0 = Date.now();
      const hits = (applyHits.get(ip) || []).filter(t => t0 - t < 3600e3);
      if (hits.length >= 20) return done(429, { error: 'Too many attempts from this device. Please try again later.' });
      hits.push(t0); applyHits.set(ip, hits);
      let b; try { b = await c.readBody(req, 30e6); } catch { return done(413, { error: 'Upload too large. Please use smaller photos.' }); }
      const vs = rd(), apps = rdA();
      const name = c.clean(b.name, 60), phone = c.clean(b.phone, 15).replace(/[\s-]/g, ''), loc = c.clean(b.location, 150);
      const secIn = ['home', 'medical', 'ambulance'].includes(b.section) ? b.section : '', isAmb = secIn === 'ambulance', section = isAmb ? 'medical' : secIn;
      const services = isAmb ? ['Ambulance'] : [...new Set((Array.isArray(b.services) ? b.services : []).map(x => c.clean(x, 60)).filter(Boolean))].slice(0, 15);
      if (!secIn) return done(400, { error: 'Please choose a partner category.' });
      if (!services.length) return done(400, { error: 'Select at least one service.' });
      if (!isAmb && services.includes('Ambulance')) return done(400, { error: 'Ambulance partners must apply through the Ambulance Partner option.' });
      if (name.length < 2) return done(400, { error: 'Enter your name.' });
      if (!phoneOk(phone)) return done(400, { error: 'Enter a valid 10-digit mobile number.' });
      if (loc.length < 3) return done(400, { error: 'Enter your address / service area.' });
      if (String(b.password || '').length < 6) return done(400, { error: 'Password must be at least 6 characters.' });
      const kinds = kindsOf(services, section), pi = profIn(b), medical = section === 'medical' && !isAmb;
      if (!pi.email) return done(400, { error: 'Enter your email address.' });
      const fe = profErr(pi, kinds, false); if (fe) return done(400, { error: fe });
      if (!/^\d{12}$/.test(pi.aadhaarNo)) return done(400, { error: 'Enter your 12-digit Aadhaar number.' });
      if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pi.panNo)) return done(400, { error: 'Enter a valid PAN number (for example ABCDE1234F).' });
      if (medical) {   // medical partners: full professional details and documents are compulsory
        if (pi.experience === '') return done(400, { error: 'Enter your years of experience.' });
        for (const k of needOf(kinds).f) if (!pi[k]) return done(400, { error: 'Enter: ' + FL[k] + '.' });
        if (!b.aadhaar || !b.pan) return done(400, { error: 'Photos of both Aadhaar and PAN are required.' });
        for (const t of needOf(kinds).d) if (!b[t]) return done(400, { error: DL[t] + ' is required.' });
      }
      const ambTypes = isAmb ? [...new Set((Array.isArray(b.ambTypes) ? b.ambTypes : []).filter(t => REQ[t]))] : [];
      if (isAmb) {   // ambulance partners: type-wise documents with expiry dates (verified one by one by the admin later)
        if (!ambTypes.length) return done(400, { error: 'Select at least one ambulance type.' });
        if (!b.aadhaar || !b.pan) return done(400, { error: 'Photos of both Aadhaar and PAN are required.' });
        for (const t of ambTypes) for (const r of REQ[t]) {
          const d = (b.ambDocs && b.ambDocs[t] && b.ambDocs[t][r[0]]) || {}, ex = String(d.expiry || '');
          if (!d.file) return done(400, { error: r[1] + ' (' + AMB_NAME[t] + ') is required.' });
          if (!/^\d{4}-\d{2}-\d{2}$/.test(ex) || ex < today()) return done(400, { error: 'Enter a valid expiry date (today or later) for ' + r[1] + ' (' + AMB_NAME[t] + ').' });
        }
      }
      if (b.declaration !== true) return done(400, { error: 'Please accept the declaration to continue.' });
      const p10 = phone.slice(-10);
      if (vs.some(y => String(y.phone).slice(-10) === p10)) return done(409, { error: 'This mobile number is already registered as a partner.' });
      if (apps.some(y => y.status === 'pending' && String(y.phone).slice(-10) === p10)) return done(409, { error: 'An application with this mobile number is already under review.' });
      const id = nextNo(secIn), docs = {};
      for (const t of ['aadhaar', 'pan', 'cert', 'reg']) if (b[t]) {
        const x = saveDoc(id, t, b[t]);
        if (!x) { delDocs(id); return done(400, { error: (DL[t] || (t === 'pan' ? 'PAN photo' : 'Aadhaar photo')) + ' is not valid (upload a clear JPG or PNG photo).' }); }
        docs[t] = x;
      }
      const ambDocs = {};
      for (const t of ambTypes) for (const r of REQ[t]) {
        const d = b.ambDocs[t][r[0]], e = saveAmbDoc(id, t, r[0], d.file);
        if (!e) { delDocs(id); return done(400, { error: r[1] + ' (' + AMB_NAME[t] + ') must be a JPG, PNG or PDF under 2.5 MB.' }); }
        (ambDocs[t] = ambDocs[t] || {})[r[0]] = { ext: e, expiry: String(d.expiry), status: 'pending', at: now() };
      }
      const salt = crypto.randomBytes(8).toString('hex');
      apps.push({ id, name, phone, location: loc, section, services, prof: { ...pi, declaration: { signed: true, at: now() } }, docs, salt, hash: hash(String(b.password), salt), status: 'pending', createdAt: now(),
        ...(isAmb ? { ambulance: true, ambTypes, ambDocs, agreement: { signed: true, at: now() } } : {}) });
      wrA(apps.slice(-300));
      fetch('https://ntfy.sh/' + c.NTFY_TOPIC, { method: 'POST', headers: { Title: 'New partner application', Priority: 'default' }, body: 'A new ' + (isAmb ? 'ambulance' : medical ? 'medical' : 'home maintenance') + ' partner application is waiting for review in the admin panel (Vendors > Applications).' }).catch(() => {});
      return done(201, { ok: true, id });
    }
    if (p === '/api/vendor/bookings') {
      const v = auth(req); if (!v) return done(401, { error: 'Please login again.' });
      // A vendor only receives job information. Aadhaar photo, payment, consent and history are never sent from here.
      const gm = u => (typeof u === 'string' && u.startsWith('https://www.google.com/maps/')) ? u : '';
      return done(200, { name: v.name, alertTopic: v.topic, bookings: c.readBookings().filter(x => x.vendorId === v.id).reverse().map(x => {
        const pm = /Pickup: (.*?) \| Drop: (.*?)(?: \| Note:|$)/.exec(x.details || ''); // for older bookings
        const pickup = x.pickup || (pm ? pm[1] : ''), drop = x.drop || (pm ? pm[2] : ''), mp = x.maps || {};
        return {
          id: x.id, service: x.service, item: x.item || '', notes: x.pickup ? (x.note || '') : (x.details || x.notes || ''), name: x.name, phone: x.phone, age: x.age || '',
          address: x.vendorStatus === 'assigned' ? String(x.address || '').replace(/\n?\s*Map:\s*\S+/i, '').trim() : x.address, pickup, drop, maps: { pickup: gm(mp.pickup), drop: gm(mp.drop), address: gm(mp.address) },
          date: x.confirmedDate || x.date || '', slot: x.slot || '', vs: x.vendorStatus, cancelled: x.status === 'cancelled', amb: x.service === 'Ambulance' ? ambOf(x) : '' };
      }) });
    }
    if (p === '/api/vendor/status' && POST) {
      const v = auth(req); if (!v) return done(401, { error: 'Please login again.' });
      const b = await body(), list = c.readBookings(), x = list.find(y => y.id === b.id && y.vendorId === v.id);
      if (!x || x.status === 'cancelled') return done(404, { error: 'Booking not found or cancelled.' });
      if (b.action === 'accept' && x.vendorStatus === 'assigned' && x.service === 'Ambulance' && !ambOk(v, ambOf(x))) return done(403, { error: 'Your ambulance documents are not valid or verified. Please contact the admin.' });
      if (b.action === 'accept' && x.vendorStatus === 'assigned') { x.vendorStatus = 'accepted'; x.status = 'confirmed'; x.partnerName = v.name; log(x, v.name + ' accepted'); }
      else if (b.action === 'done' && x.vendorStatus === 'accepted') { x.vendorStatus = 'done'; x.status = 'completed'; log(x, v.name + ' marked done'); }
      else return done(400, { error: 'Not allowed.' });
      c.saveBookings(list); return done(200, { ok: true });
    }

    // ---- admin only ----
    if (req.headers['x-admin-key'] !== c.ADMIN_KEY) return done(401, { error: 'Wrong admin key' });
    if (p === '/api/admin/vendor-booking' && req.method === 'DELETE') {
      const id = c.clean(url.searchParams.get('id'), 40), list = c.readBookings();
      if (!list.some(x => x.id === id)) return done(404, { error: 'Booking not found' });
      c.saveBookings(list.filter(x => x.id !== id)); return done(200, { ok: true });
    }
    if (p === '/api/admin/vendor-sections' && req.method === 'GET') { // booking id -> service/category, so the page can split Home vs Medical
      const o = {}; c.readBookings().forEach(b => { o[b.id] = keyOf(b) || ''; }); return done(200, o);
    }
    if (p === '/api/admin/vendor-applications' && req.method === 'GET') {
      return done(200, rdA().map(a => ({ id: a.id, name: a.name, phone: a.phone, location: a.location, section: a.section, services: a.services, prof: a.prof || {},
        kyc: { aadhaar: !!(a.docs && a.docs.aadhaar), pan: !!(a.docs && a.docs.pan), cert: !!(a.docs && a.docs.cert), reg: !!(a.docs && a.docs.reg) }, status: a.status, note: a.note || '', createdAt: a.createdAt, ambulance: !!a.ambulance, ambTypes: a.ambTypes || [], amb: a.ambulance ? ambView(a) : null })));
    }
    if (p === '/api/admin/vendor-applications' && POST) {
      const b = await body(), apps = rdA(), a = apps.find(x => x.id === b.id);
      if (!a) return done(404, { error: 'Application not found.' });
      if (b.action === 'approve') {
        if (a.status !== 'pending') return done(400, { error: 'Only pending applications can be approved.' });
        const vs = rd(); if (vs.some(x => x.id.toLowerCase() === a.id.toLowerCase())) return done(409, { error: 'A vendor with this ID already exists.' });
        const nv = { id: a.id, name: a.name, phone: a.phone, location: a.location, section: a.section, services: a.services, ambTypes: a.ambTypes || [], ambDocs: a.ambDocs, agreement: a.agreement, active: true, docs: a.docs, prof: { ...a.prof, verified: false },
          topic: 'gth-v-' + a.id.toLowerCase() + '-' + crypto.randomBytes(6).toString('hex'), salt: a.salt, hash: a.hash, createdAt: now(), approvedAt: now(), source: 'self-enrolled' };
        if (a.section === 'medical' && !a.ambulance && b.verify === true && profComplete(nv)) { nv.prof.verified = true; nv.prof.verifiedAt = now(); }
        vs.push(nv); wr(vs); wrA(apps.filter(x => x !== a));
        const url = (process.env.SITE_URL || ('http://' + (req.headers.host || 'localhost:3000'))).replace(/\/$/, '');
        const text = 'Dear ' + nv.name + ',\n\nCongratulations! Your application to join Ghar to Health as a service partner has been approved.\n\nYour Partner ID: ' + nv.id + '\nPartner login: ' + url + '/vendor.html\n(Log in with your Partner ID and the password you created while applying.)\n\nTo get an instant alert on your phone whenever a client request matches your service:\n1. Install the free \"ntfy\" app (Android or iPhone).\n2. Tap \"+\" and subscribe to this topic: ' + nv.topic + '\n3. Allow notifications and set the sound / priority to the maximum.' + (a.ambulance ? '\n\nIMPORTANT: our team will now verify each of your ambulance documents. You will start receiving ambulance requests only after all your documents are verified.' : '') + '\n\nWelcome aboard!\nGhar to Health Team';
        const r = a.prof && a.prof.email ? await mailer.send(a.prof.email, 'Welcome to Ghar to Health - your partner application is approved', text) : { sent: false, reason: 'no email address' };
        const wa = 'https://wa.me/91' + String(nv.phone).slice(-10) + '?text=' + encodeURIComponent('Congratulations ' + nv.name + '! Your application to join Ghar to Health as a service partner has been approved.\nPartner ID: ' + nv.id + '\nLogin: ' + url + '/vendor.html (use the password you created while applying).\nWelcome aboard! - Ghar to Health Team');
        return done(200, { ok: true, id: nv.id, name: nv.name, emailSent: r.sent, emailReason: r.reason || '', whatsapp: wa });
      }
      if (b.action === 'reject') {
        if (a.status !== 'pending') return done(400, { error: 'Only pending applications can be rejected.' });
        a.status = 'rejected'; a.note = c.clean(b.note, 200); a.docs = {}; delDocs(a.id); wrA(apps); return done(200, { ok: true });
      }
      if (b.action === 'delete') { delDocs(a.id); wrA(apps.filter(x => x !== a)); return done(200, { ok: true }); }
      return done(400, { error: 'Invalid action.' });
    }
    if (p === '/api/admin/vendors' && req.method === 'GET') {
      const list = c.readBookings(), open = v => list.filter(x => x.vendorId === v.id && x.vendorStatus !== 'done' && x.status !== 'cancelled').length;
      return done(200, rd().map(v => ({ id: v.id, name: v.name, phone: v.phone, location: v.location || '', section: v.section || '', services: v.services, ambTypes: v.ambTypes || [], amb: ambView(v), agreement: !!(v.agreement && v.agreement.signed), active: v.active, topic: v.topic,
        kyc: { aadhaar: !!(v.docs && v.docs.aadhaar), pan: !!(v.docs && v.docs.pan), cert: !!(v.docs && v.docs.cert), reg: !!(v.docs && v.docs.reg) },
        prof: v.prof || null, profNeeded: kindsOf(v.services, v.section).length > 0, profComplete: profComplete(v), profVerified: !!(v.prof && v.prof.verified), open: open(v), done: list.filter(x => x.vendorId === v.id && x.vendorStatus === 'done').length })));
    }
    if (p === '/api/admin/vendor-doc' && url.searchParams.get('key')) {
      const id = c.clean(url.searchParams.get('id'), 20), t = url.searchParams.get('type'), k = url.searchParams.get('key');
      const v = rd().find(x => x.id === id) || rdA().find(x => x.id === id), d = v && v.ambDocs && v.ambDocs[t] && v.ambDocs[t][k];
      if (!d) return done(404, { error: 'No document' });
      try { c.send(res, 200, fs.readFileSync(path.join(DOCS, id + '-' + t + '-' + k + '.' + d.ext)), { 'Content-Type': d.ext === 'pdf' ? 'application/pdf' : d.ext === 'png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store' }); return true; }
      catch { return done(404, { error: 'File missing' }); }
    }
    if (p === '/api/admin/vendor-doc') {
      const id = c.clean(url.searchParams.get('id'), 20), t = url.searchParams.get('type');
      const v = rd().find(x => x.id === id) || rdA().find(x => x.id === id), e = v && v.docs && ['aadhaar', 'pan', 'cert', 'reg'].includes(t) && v.docs[t];
      if (!e) return done(404, { error: 'No document' });
      try { c.send(res, 200, fs.readFileSync(path.join(DOCS, id + '-' + t + '.' + e)), { 'Content-Type': e === 'png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store' }); return true; }
      catch { return done(404, { error: 'File missing' }); }
    }
    if (p === '/api/admin/vendors' && POST) {
      const b = await body(), l = rd(), id0 = c.clean(b.id, 20), phone = c.clean(b.phone, 15).replace(/[\s-]/g, ''), loc = c.clean(b.location, 150);
      const services = (Array.isArray(b.services) ? b.services : []).map(s => c.clean(s, 60)).filter(Boolean);
      let id = id0; // blank ID = next sequential partner number (GTHH0001 / GTHM0001)
      if (!id) id = nextNo(b.section);
      if (!/^[A-Za-z0-9_]{3,20}$/.test(id)) return done(400, { error: 'ID: 3-20 letters/numbers only.' });
      if (l.some(x => x.id.toLowerCase() === id.toLowerCase())) return done(409, { error: 'ID already exists.' });
      if (c.clean(b.name, 60).length < 2) return done(400, { error: 'Enter vendor name.' });
      if (!phoneOk(phone)) return done(400, { error: 'Enter a valid 10-digit mobile number.' });
      if (loc.length < 3) return done(400, { error: 'Enter vendor location / address.' });
      if (String(b.password || '').length < 6) return done(400, { error: 'Password min 6 characters.' });
      if (!services.length) return done(400, { error: 'Select at least one service.' });
      const ambTypes = services.includes('Ambulance') ? ambClean(b.ambTypes) : [];
      if (services.includes('Ambulance') && !ambTypes.length) return done(400, { error: ambErr });
      if (services.includes('Ambulance') && b.agreement !== true) return done(400, { error: 'Please tick the box to confirm the Vendor Agreement is signed.' });
      const nonAmb = services.filter(x => x !== 'Ambulance'), kinds = kindsOf(services, b.section);
      let prof = null;
      if (nonAmb.length) {   // Ambulance-only vendors use the ambulance document system instead
        const pi = profIn(b), pe = profErr(pi, kinds, true); if (pe) return done(400, { error: pe });
        if (kinds.length && b.declaration !== true) return done(400, { error: 'Please tick the vendor declaration.' });
        for (const t of needOf(kinds).d) if (!b[t]) return done(400, { error: DL[t] + ' is required.' });
        prof = { ...pi, ...(b.declaration === true ? { declaration: { signed: true, at: now() } } : {}) };
      }
      const a = saveDoc(id, 'aadhaar', b.aadhaar), pn = saveDoc(id, 'pan', b.pan);
      if (!a || !pn) { delDocs(id); return done(400, { error: 'Clear photos of both Aadhaar and PAN are required.' }); }
      const docs = { aadhaar: a, pan: pn };
      for (const t of ['cert', 'reg']) if (b[t]) { const x = saveDoc(id, t, b[t]); if (!x) { delDocs(id); return done(400, { error: DL[t] + ' is not valid (upload a clear JPG or PNG photo).' }); } docs[t] = x; }
      const salt = crypto.randomBytes(8).toString('hex');
      l.push({ id, name: c.clean(b.name, 60), phone, location: loc, section: ['home', 'medical'].includes(b.section) ? b.section : '', services, ambTypes, active: true, docs, prof: prof || undefined, agreement: b.agreement === true ? { signed: true, at: now() } : undefined, topic: 'gth-v-' + id.toLowerCase() + '-' + crypto.randomBytes(6).toString('hex'), salt, hash: hash(String(b.password), salt), createdAt: now() });
      wr(l); return done(201, { ok: true, id });
    }
    if (p === '/api/admin/vendors' && req.method === 'PUT') {
      const b = await body(), l = rd(), v = l.find(x => x.id === b.id);
      if (!v) return done(404, { error: 'Not found' });
      if (b.name) { if (c.clean(b.name, 60).length < 2) return done(400, { error: 'Enter vendor name.' }); v.name = c.clean(b.name, 60); }
      if (b.phone) { const ph = c.clean(b.phone, 15).replace(/[\s-]/g, ''); if (!phoneOk(ph)) return done(400, { error: 'Enter a valid 10-digit mobile number.' }); v.phone = ph; }
      if (b.location) v.location = c.clean(b.location, 150);
      if (['home', 'medical'].includes(b.section)) v.section = b.section;
      if (b.agreement === true && !(v.agreement && v.agreement.signed)) v.agreement = { signed: true, at: now() };
      if (Array.isArray(b.services) && b.services.length) v.services = b.services.map(s => c.clean(s, 60)).filter(Boolean);
      if (Array.isArray(b.ambTypes)) v.ambTypes = ambClean(b.ambTypes);
      if (Array.isArray(b.services) || Array.isArray(b.ambTypes)) {
        if (!v.services.includes('Ambulance')) v.ambTypes = [];
        else if (!(v.ambTypes || []).length) return done(400, { error: ambErr });
      }
      if (b.password) { if (String(b.password).length < 6) return done(400, { error: 'Password min 6 characters.' }); v.salt = crypto.randomBytes(8).toString('hex'); v.hash = hash(String(b.password), v.salt); }
      const pOld = JSON.stringify(v.prof || {});
      if (b.prof && typeof b.prof === 'object') {   // update professional details (formats are checked, completeness only shown in the list)
        const np = profIn(b), pe = profErr(np, [], false); if (pe) return done(400, { error: pe });
        v.prof = v.prof || {}; PKEYS.forEach(k => { if (b.prof[k] !== undefined) v.prof[k] = np[k]; });
      }
      if (b.declaration === true && !(v.prof && v.prof.declaration && v.prof.declaration.signed)) (v.prof = v.prof || {}).declaration = { signed: true, at: now() };
      for (const t of ['aadhaar', 'pan', 'cert', 'reg']) if (b[t]) { const e = saveDoc(v.id, t, b[t]); if (!e) return done(400, { error: t + ' photo invalid.' }); (v.docs = v.docs || {})[t] = e; if (v.prof && t !== 'aadhaar' && t !== 'pan') v.prof.verified = false; }
      if (v.prof && JSON.stringify({ ...v.prof, verified: 0, verifiedAt: 0 }) !== JSON.stringify({ ...JSON.parse(pOld), verified: 0, verifiedAt: 0 }) && b.profVerified === undefined) { v.prof.verified = false; delete v.prof.verifiedAt; }
      if (typeof b.profVerified === 'boolean') {
        if (b.profVerified && !profComplete(v)) return done(400, { error: 'Complete all professional details and photos first, then verify.' });
        v.prof = v.prof || {}; v.prof.verified = b.profVerified; if (b.profVerified) v.prof.verifiedAt = now(); else delete v.prof.verifiedAt;
      }
      const nid = c.clean(b.newId, 20); // change Login ID (docs + bookings follow the new ID)
      if (nid && nid !== v.id) {
        if (!/^[A-Za-z0-9_]{3,20}$/.test(nid)) return done(400, { error: 'ID: 3-20 letters/numbers only.' });
        if (l.some(x => x !== v && x.id.toLowerCase() === nid.toLowerCase())) return done(409, { error: 'ID already exists.' });
        const old = v.id;
        try { fs.readdirSync(DOCS).filter(f => f.startsWith(old + '-')).forEach(f => { try { fs.renameSync(path.join(DOCS, f), path.join(DOCS, nid + f.slice(old.length))); } catch {} }); } catch {}
        v.id = nid; const bl = c.readBookings(); bl.forEach(x => { if (x.vendorId === old) x.vendorId = nid; }); c.saveBookings(bl);
      }
      const was = v.active; if (typeof b.active === 'boolean') v.active = b.active;
      wr(l); if (was && !v.active) release(v, ' suspended'); sweep();
      return done(200, { ok: true, id: v.id });
    }
    if (p === '/api/admin/vendors' && req.method === 'DELETE') {
      const id = c.clean(url.searchParams.get('id'), 20), l = rd(), v = l.find(x => x.id === id);
      if (!v) return done(404, { error: 'Not found' });
      wr(l.filter(x => x.id !== id)); release(v, ' removed'); delDocs(id);
      return done(200, { ok: true });
    }
    if (p === '/api/admin/vendor-amb-doc' && POST) {
      const b = await body(), l = rd(), v = l.find(x => x.id === b.id), t = String(b.type || ''), k = String(b.key || '');
      if (!v) return done(404, { error: 'Vendor not found' });
      if (!REQ[t] || !REQ[t].some(r => r[0] === k)) return done(400, { error: 'Invalid document.' });
      v.ambDocs = v.ambDocs || {}; v.ambDocs[t] = v.ambDocs[t] || {};
      const set = v.ambDocs[t], old = set[k];
      const ex = b.expiry === undefined ? undefined : String(b.expiry);
      if (ex !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(ex) || ex < today())) return done(400, { error: 'Enter a valid expiry date (today or a future date).' });
      if (b.file && !ex && !(old && old.expiry)) return done(400, { error: 'Enter the expiry date.' });
      let d = old;
      if (b.file) {
        const e = saveAmbDoc(v.id, t, k, b.file);
        if (!e) return done(400, { error: 'The file must be a JPG, PNG or PDF (max 2.5 MB).' });
        d = set[k] = { ext: e, expiry: ex || (old && old.expiry) || '', status: 'pending', at: now() };
      } else if (!d) return done(400, { error: 'Upload the file first.' });
      else if (ex !== undefined && ex !== d.expiry) { d.expiry = ex; d.status = 'pending'; }
      if (typeof b.verify === 'boolean') {
        if (b.verify && (!d.expiry || d.expiry < today())) return done(400, { error: 'A valid expiry date is required before verifying.' });
        d.status = b.verify ? 'verified' : 'pending'; d.verifiedAt = b.verify ? now() : undefined;
      }
      wr(l); sweep(); return done(200, { ok: true });
    }
    if (p === '/api/admin/auto-assign' && POST) {
      const list = c.readBookings(); let n = 0;
      list.forEach(x => { if (!x.vendorId && x.status !== 'cancelled' && x.status !== 'completed' && assign(x, list)) n++; });
      c.saveBookings(list); return done(200, { assigned: n });
    }
    if (p === '/api/admin/assign' && POST) {
      const b = await body(), list = c.readBookings(), x = list.find(y => y.id === b.bookingId);
      if (!x) return done(404, { error: 'Booking not found' });
      const v = b.vendorId ? rd().find(y => y.id === b.vendorId && y.active) : null;
      if (b.vendorId && !v) return done(400, { error: 'Vendor is suspended or not found.' });
      if (v && x.service === 'Ambulance' && ambOf(x) && !(v.ambTypes || []).includes(ambOf(x))) return done(400, { error: 'This vendor does not offer this ambulance type. Choose a vendor of the same type.' });
      if (v && x.service === 'Ambulance' && !ambOk(v, ambOf(x))) return done(400, { error: 'This vendor\'s ambulance documents are not verified or valid. Verify the documents first.' });
      Object.assign(x, v ? { vendorId: v.id, vendorName: v.name, vendorStatus: 'assigned' } : { vendorId: '', vendorName: '', vendorStatus: '' },
        { partnerName: '', status: x.status === 'cancelled' ? 'cancelled' : 'new' });
      log(x, v ? 'Admin assigned to ' + v.name : 'Admin removed vendor'); c.saveBookings(list);
      if (v) ping(v, x); return done(200, { ok: true });
    }
    return done(404, { error: 'Not found' });
  }
  sweep(); setInterval(sweep, 3600e3).unref();
  return { handle, assign, sweep, auth };
};
