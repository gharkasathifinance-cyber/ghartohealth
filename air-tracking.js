// Air Ambulance: live tracking, flight log and leg-wise billing (Ghar to Health)
// Works on top of ambulance.js. No npm packages. Data: data/air-rates.json, data/flight-tracks/<booking>.json,
// and a "flight" object saved inside the booking in data/bookings.json.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const TYPES = { heli: 'Helicopter Ambulance', charter: 'Charter Aircraft (Jet)' };
// Rate card. Admin changes these from admin-air.html. 0 = not set yet.
const DEF_RATES = {
  hourlyRate: 0,      // Rs per flight hour charged by the operator
  avgSpeedKmh: 200,   // used for estimates and ETA
  routeFactor: 1.1,   // flight route is longer than the straight line
  positioningPct: 100, // % of hourly rate charged for the empty leg base -> pickup
  returnPct: 100,     // % of hourly rate charged for the empty leg back to base
  landingFee: 0,      // Rs per landing (airport / helipad)
  waitingPerHour: 0,  // Rs per hour of ground waiting beyond the free time
  freeWaitMin: 45,    // free ground time at each stop
  groundMin: 20,      // expected ground time at pickup (used for ETA only)
  minHours: 1,        // minimum billable flight hours
  useExtras: 1        // 1 = also add the extra charges from admin-charges.html (medical team, ground ambulance ...)
};
const DEF_BY_TYPE = { heli: { ...DEF_RATES }, charter: { ...DEF_RATES, avgSpeedKmh: 600, minHours: 1.5 } };
const LIMITS = { hourlyRate: [0, 5e6], avgSpeedKmh: [50, 1000], routeFactor: [1, 2], positioningPct: [0, 100], returnPct: [0, 100], landingFee: [0, 5e6],
  waitingPerHour: [0, 5e6], freeWaitMin: [0, 600], groundMin: [0, 240], minHours: [0, 24], useExtras: [0, 1] };

module.exports = function (c) {
  const D = path.join(__dirname, 'data'), TR = path.join(D, 'flight-tracks'), RATE_FILE = path.join(D, 'air-rates.json'), BASE_FILE = path.join(D, 'air-base.json'),
    OP_FILE = path.join(D, 'air-operators.json'), HOLD_FILE = path.join(D, 'air-holds.json'), HOLD_MIN = 15;
  // SPEED: small settings files (operators, rates, documents, holds) are re-read from disk only when the file really changed
  // (same size + modified time). The text is cached, never the parsed object, so callers can still change what they get.
  const fcache = new Map();
  const rd = (f, d) => {
    try {
      const s = fs.statSync(f), k = s.mtimeMs + ':' + s.size, e = fcache.get(f);
      let txt; if (e && e.k === k) txt = e.txt; else { txt = fs.readFileSync(f, 'utf8'); fcache.set(f, { k, txt }); }
      return JSON.parse(txt);
    } catch { return d; }
  };
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  // ---------- rates ----------
  function getRates() {
    const s = rd(RATE_FILE, {}), out = {};
    for (const t of Object.keys(TYPES)) {
      out[t] = { ...DEF_BY_TYPE[t] };
      for (const k of Object.keys(LIMITS)) { const v = Number(s[t] && s[t][k]); if (Number.isFinite(v) && v >= LIMITS[k][0] && v <= LIMITS[k][1]) out[t][k] = v; }
    }
    return out;
  }


  // ---------- OPERATORS: admin lists every air service operator once (data/air-operators.json). The FIRST FREE operator
  // (list order = priority) gets the booking. Each operator has its own base airport and rates.
  const ratesOf = f => f.R ? { ...DEF_BY_TYPE[f.aircraft], ...f.R } : getRates()[f.aircraft];
  const mkRates = (type, r) => { const out = { ...DEF_BY_TYPE[type] }; for (const k of Object.keys(LIMITS)) { const v = Number(r && r[k]); if (r && r[k] !== '' && r[k] !== null && Number.isFinite(v) && v >= LIMITS[k][0] && v <= LIMITS[k][1]) out[k] = v; } return out; };
  const regOf = v => c.clean(v, 12).toUpperCase().replace(/[^A-Z0-9-]/g, '');   // aircraft registration, e.g. VT-ABC
  const getOps = () => { const l = rd(OP_FILE, []); return (Array.isArray(l) ? l : []).filter(o => o && TYPES[o.aircraft]).map(o => ({ id: String(o.id), name: String(o.name || ''), phone: String(o.phone || ''), note: String(o.note || ''), reg: regOf(o.reg),
    aircraft: o.aircraft, active: o.active !== false, createdAt: o.createdAt || 0, rates: mkRates(o.aircraft, o.rates), base: pt(o.base, o.base && o.base.name) })); };
  // An operator is offered bookings only when ALL its documents are Verified and not expired (see OPERATOR DOCUMENTS below).
  const docsOk = o => docView(o.id).every(d => d.state === 'verified');
  const isReady = o => o.active && !!o.base && o.rates.hourlyRate > 0 && docsOk(o);

  // ---------- OPERATOR DOCUMENTS: each operator has its own documents (data/air-operator-docs.json, files in data/air-operator-docs/) ----------
  const DOC_FILE = path.join(D, 'air-operator-docs.json'), DOC_DIR = path.join(D, 'air-operator-docs');
  const OP_DOCS = [['aoc', 'DGCA Permit (AOC/NSOP)'], ['cor', 'Aircraft Registration Certificate'], ['coa', 'Airworthiness Certificate'], ['ins', 'Aircraft Insurance'], ['med', 'Medical Team Registration (Doctor / Paramedic)']];
  const rdDocs = () => { const o = rd(DOC_FILE, {}); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; };
  const wrDocs = o => { fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(DOC_FILE, JSON.stringify(o, null, 2)); };
  const todayIN = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  const docState = d => !d ? 'missing' : (d.expiry && d.expiry < todayIN()) ? 'expired' : d.status === 'verified' ? 'verified' : 'pending';
  const docView = id => { const m = rdDocs()[id] || {}; return OP_DOCS.map(r => { const d = m[r[0]]; return { key: r[0], name: r[1], state: docState(d), expiry: (d && d.expiry) || '', ext: d ? d.ext : '' }; }); };
  function saveOpDoc(id, k, u) {
    const m = /^data:(image\/jpeg|image\/png|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(u || ''));
    if (!m) return null;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 500 || buf.length > 2.5e6) return null;
    const ok = m[1] === 'application/pdf' ? buf.slice(0, 4).toString() === '%PDF' : m[1] === 'image/jpeg' ? buf[0] === 0xFF && buf[1] === 0xD8 : buf[0] === 0x89 && buf[1] === 0x50;
    if (!ok) return null;
    const ext = m[1] === 'application/pdf' ? 'pdf' : m[1] === 'image/jpeg' ? 'jpg' : 'png';
    fs.mkdirSync(DOC_DIR, { recursive: true });
    ['jpg', 'png', 'pdf'].forEach(e => { try { fs.unlinkSync(path.join(DOC_DIR, id + '-' + k + '.' + e)); } catch {} });
    fs.writeFileSync(path.join(DOC_DIR, id + '-' + k + '.' + ext), buf); return ext;
  }
  // ---------- ONLINE APPLICATIONS: an operator agency fills operator-apply.html; its card is created here with "Available" OFF,
  // so it gets no booking until the admin verifies the documents and switches it on. Extra details live in data/air-operator-apps.json.
  const APP_FILE = path.join(D, 'air-operator-apps.json'), APP_HOURS = 48;   // the applicant may upload documents for 48 hours after submitting
  const rdApps = () => { const o = rd(APP_FILE, {}); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; };
  const wrApps = o => { fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(APP_FILE, JSON.stringify(o, null, 2)); };
  const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
  const appView = id => { const a = rdApps()[id]; return a ? { person: a.person || '', email: a.email || '', at: a.at || '', aadhaar: !!(a.ids && a.ids.aadhaar), pan: !!(a.ids && a.ids.pan) } : null; };
  const imgOf = u => {   // JPG / PNG photo as a data URL, checked by its first bytes
    const m = /^data:(image\/jpeg|image\/png);base64,([A-Za-z0-9+/=]+)$/.exec(String(u || '')); if (!m) return null;
    const buf = Buffer.from(m[2], 'base64'); if (buf.length < 500 || buf.length > 2.5e6) return null;
    const ok = m[1] === 'image/jpeg' ? buf[0] === 0xFF && buf[1] === 0xD8 : buf[0] === 0x89 && buf[1] === 0x50;
    return ok ? { buf, ext: m[1] === 'image/jpeg' ? 'jpg' : 'png' } : null;
  };
  const hits = new Map();   // simple rate limit for the public form: kind|ip -> timestamps
  const rateOk = (req, kind, max) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), k = kind + '|' + ip, now = Date.now(), l = (hits.get(k) || []).filter(t => now - t < 36e5);
    if (l.length >= max) { hits.set(k, l); return false; }
    l.push(now); hits.set(k, l); if (hits.size > 2000) hits.clear(); return true;
  };
  const RLAB = { hourlyRate: 'Hourly rate', avgSpeedKmh: 'Average speed', routeFactor: 'Route factor', positioningPct: 'Empty leg (base to pickup) %', returnPct: 'Empty return leg %', landingFee: 'Landing fee',
    waitingPerHour: 'Waiting charge', freeWaitMin: 'Free waiting minutes', groundMin: 'Ground time', minHours: 'Minimum billable hours', useExtras: 'Extras' };
  const holdsNow = () => rd(HOLD_FILE, []).filter(h => h && h.until > Date.now());
  const saveHolds = l => { fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(HOLD_FILE, JSON.stringify(l)); };
  // SPEED: bookings.json holds signatures and is big, so reading it on every price check made the quote slow.
  // Price checks may use a result up to 5 seconds old; assigning / confirming an operator always reads fresh (fresh = true).
  let busyCache = { at: 0, m: {} };
  function busyMap(fresh) {   // operatorId -> booking id, for every booking that still keeps its operator
    if (!fresh && Date.now() - busyCache.at < 5000) return busyCache.m;
    const m = {};
    for (const b of c.readBookings()) if (b.operatorId && b.status !== 'cancelled' && b.status !== 'completed' && !(b.flight && b.flight.final)) m[b.operatorId] = b.id;
    busyCache = { at: Date.now(), m }; return m;
  }
  // first free, ready operator of this type. A hold with the same key/ref (same client retrying) does not block that client.
  function pickOperator(type, hold) {
    const ops = getOps().filter(o => o.aircraft === type), ready = ops.filter(isReady);
    if (!ready.length) return { error: 'Price for this service is not available right now. Please call us to book.', why: 'no ready operator' };
    const busy = busyMap(), holds = holdsNow().filter(h => !(hold && ((hold.ref && h.ref === hold.ref) || (hold.key && h.key === hold.key))));
    const op = ready.find(o => !busy[o.id] && !holds.some(h => h.opId === o.id));
    return op ? { op } : { error: 'All our ' + TYPES[type] + ' operators are busy with other missions right now. Please call us and we will arrange the next available aircraft.', why: 'all busy' };
  }
  function placeHold(opId, hold) {   // keeps the operator for this client while he pays (HOLD_MIN minutes)
    const l = holdsNow().filter(h => h.ref !== hold.ref && h.key !== hold.key);
    l.push({ opId, ref: hold.ref, key: hold.key || '', until: Date.now() + HOLD_MIN * 6e4 }); saveHolds(l);
  }
  function releaseHold(ref) { const l = holdsNow(), k = l.filter(h => h.ref !== ref); if (k.length !== l.length) saveHolds(k); }
  // payment done: finalise the operator for this booking (the held one if still free, otherwise the next free one)
  function confirmOperator(ref, opId, type) {
    const ops = getOps(), busy = busyMap(true), others = holdsNow().filter(h => h.ref !== ref);
    const ok = o => o && isReady(o) && !busy[o.id] && !others.some(h => h.opId === o.id);
    let op = ops.find(o => o.id === opId), changed = false;
    if (!ok(op)) { op = ops.find(o => o.aircraft === type && ok(o)); changed = true; }
    releaseHold(ref);
    return op ? { id: op.id, name: op.name, phone: op.phone, changed: changed && !!opId } : null;
  }
  const opView = id => { const o = getOps().find(x => x.id === id); return o ? { id: o.id, name: o.name, phone: o.phone, reg: o.reg, base: o.base } : null; };

  // ---------- geometry ----------
  const rad = d => d * Math.PI / 180;
  // Ground ambulance is charged only for the ends the client asked for (both ends = full amount, one end = half).
  const adjGround = (list, o) => {
    if (!o || !o.groundPickup || !o.groundDrop) return list;
    const n = (o.groundPickup === 'yes' ? 1 : 0) + (o.groundDrop === 'yes' ? 1 : 0), out = [];
    for (const e of list) {
      if (!/ground\s*ambulance/i.test(e.label)) { out.push(e); continue; }
      if (n === 2) out.push(e);
      else if (n === 1) out.push({ label: e.label.replace(/\s*\(.*?\)\s*/g, ' ').trim() + ' (' + (o.groundPickup === 'yes' ? 'pickup end' : 'drop end') + ')', amount: Math.round(e.amount / 2) });
    }
    return out;
  };
  const distKm = (a, b) => { const R = 6371, dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
  const pt = (v, name) => (v && Number.isFinite(+v.lat) && Number.isFinite(+v.lng) && Math.abs(+v.lat) <= 90 && Math.abs(+v.lng) <= 180)
    ? { name: c.clean(name || v.name || '', 80), lat: +(+v.lat).toFixed(5), lng: +(+v.lng).toFixed(5) } : null;
  const fromMapUrl = u => { const m = /query=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(String(u || '')); return m ? { lat: +m[1], lng: +m[2] } : null; };
  const lerp = (a, b, p) => ({ lat: a.lat + (b.lat - a.lat) * p, lng: a.lng + (b.lng - a.lng) * p });
  // Best operator first: base nearest to the client's pickup, then the operator with fewer bookings so far, then the admin's own priority order.
  const rankOps = (bk, ops, list) => {
    const pk = fromMapUrl(bk.maps && bk.maps.pickup), cnt = {};
    (list || []).forEach(y => { if (y.operatorId) cnt[y.operatorId] = (cnt[y.operatorId] || 0) + 1; });
    return ops.map((o, i) => ({ o, i, d: (pk && o.base) ? distKm(o.base, pk) : Infinity, n: cnt[o.id] || 0 }))
      .sort((a, b) => (a.d - b.d) || (a.n - b.n) || (a.i - b.i)).map(x => x.o);
  };
  const isDemoBk = bk => !(bk.payment && bk.payment.mode === 'razorpay');   // demo / unpaid test booking

  // ---------- flight log maths ----------
  const plannedHours = (f, l, R) => distKm(l.from, l.to) * R.routeFactor / R.avgSpeedKmh;
  const legHours = (f, l, R, now) => {   // actual hours from the take-off / landing log (simulated legs are scaled back to real flight time)
    const k = l.simFactor || 1;
    if (l.startedAt && l.endedAt) return (l.endedAt - l.startedAt) * k / 36e5;
    if (l.startedAt) return (now - l.startedAt) * k / 36e5;
    return plannedHours(f, l, R);
  };
  const gapMin = (a, b) => (a && b && a.endedAt && b.startedAt) ? Math.max(0, (b.startedAt - a.endedAt) * (b.simFactor || 1) / 6e4) : 0;
  const money = n => Math.round(n);
  const REVIEW_PCT = 25;   // final bill more than this % above the estimate is flagged "needs review" for the admin

  // mode 'estimate' = planned route only; 'actual' = flight log (live while flying, final once finished)
  function bill(bk, mode) {
    const f = bk.flight, R = ratesOf(f), cfg = c.ambulance.getCfg(), now = Date.now(), items = [];
    let hours = 0, landings = 0, waitMin = 0;
    f.legs.forEach((l, i) => {
      const act = mode === 'actual' && l.startedAt, h = act ? legHours(f, l, R, now) : plannedHours(f, l, R);
      const pct = l.type === 'positioning' ? R.positioningPct : l.type === 'return' ? R.returnPct : 100;
      hours += h; if (!act || l.endedAt) landings += 1;
      items.push({ kind: 'leg', legId: l.id, type: l.type, label: l.from.name + ' to ' + l.to.name + ' (' + h.toFixed(2) + ' h' + (pct < 100 ? ' at ' + pct + '%' : '') + ')',
        hours: +h.toFixed(3), amount: money(h * R.hourlyRate * pct / 100) });
      if (mode === 'actual' && i > 0) waitMin += Math.max(0, gapMin(f.legs[i - 1], l) - R.freeWaitMin);
    });
    if (hours < R.minHours && R.hourlyRate > 0) items.push({ kind: 'min', label: 'Minimum billing adjustment (' + R.minHours + ' h minimum)', amount: money((R.minHours - hours) * R.hourlyRate) });
    if (R.landingFee > 0 && landings) items.push({ kind: 'landing', label: 'Landing fees (' + landings + ' landings)', amount: money(landings * R.landingFee) });
    if (waitMin > 0 && R.waitingPerHour > 0) items.push({ kind: 'wait', label: 'Ground waiting beyond free time (' + Math.round(waitMin) + ' min)', amount: money(waitMin / 60 * R.waitingPerHour) });
    if (R.useExtras) for (const e of (cfg.extras[f.aircraft] || [])) items.push({ kind: 'extra', label: e.label, amount: e.amount });
    const serviceTotal = items.reduce((s, i) => s + i.amount, 0), fee = money(serviceTotal * cfg.feePct / 100), gst = money(fee * cfg.gstPct / 100);
    return { mode, items, hours: +hours.toFixed(2), serviceTotal, feePct: cfg.feePct, fee, gstPct: cfg.gstPct, gst, total: serviceTotal + fee + gst, ratesSet: R.hourlyRate > 0 };
  }

  // ---------- base airport (where each aircraft is parked) + instant quote for the client ----------
  const getBase = () => { const s = rd(BASE_FILE, {}), out = {}; for (const t of Object.keys(TYPES)) { const v = pt(s[t], s[t] && s[t].name); if (v) out[t] = v; } return out; };
  // Price shown to the client once pickup and drop are known. Same maths as the admin route calculator:
  // base -> pickup (empty), pickup -> drop (patient), drop -> base (empty). Returns { error } when the admin has not set the hourly rate or base airport yet (no fixed-price fallback).
  function airQuote(type, pickup, drop, opts) {
    opts = opts || {};
    let R, base, opId = '';
    if (getOps().some(o => o.aircraft === type)) {   // operator mode: price comes from the first free operator
      const pk = pickOperator(type, opts.hold);
      if (pk.error) { console.log('[air-quote] ' + type + ': ' + pk.why + ' (data/air-operators.json). Admin: open admin-operators.html.'); return { error: pk.error }; }
      R = pk.op.rates; base = pk.op.base; opId = pk.op.id;
    } else {   // no operators listed for this type yet: old single rate card + base
      R = getRates()[type]; base = getBase()[type];
      if (!R || !(R.hourlyRate > 0)) console.log('[air-quote] ' + type + ': hourly rate is 0 or not saved (data/air-rates.json). Admin: set it and press Save all changes.');
      else if (!base) console.log('[air-quote] ' + type + ': base airport not saved (data/air-base.json). Admin: pick the base airport and press Save all changes.');
    }
    if (!R || !(R.hourlyRate > 0) || !base) return { error: 'Price for this service is not available right now. Please call us to book.' };
    const P = pt(pickup, 'Pickup'), Q = pt(drop, 'Drop');
    if (!P || !Q) return { error: 'Please choose pickup and drop from the suggestion list, or tap \"Use my current location\".' };
    if (opId && opts.hold && opts.hold.ref) placeHold(opId, opts.hold);
    const cfg = c.ambulance.getCfg(), items = []; let hours = 0;
    const legs = [['Aircraft to pickup', base, P, R.positioningPct], ['Patient flight', P, Q, 100], ['Return to base', Q, base, R.returnPct]];
    legs.forEach(l => { const km = distKm(l[1], l[2]) * R.routeFactor, h = km / R.avgSpeedKmh; hours += h;
      items.push({ label: l[0] + ' (' + Math.round(km) + ' km, ' + h.toFixed(2) + ' h' + (l[3] < 100 ? ' at ' + l[3] + '%' : '') + ')', amount: money(h * R.hourlyRate * l[3] / 100) }); });
    if (hours < R.minHours) items.push({ label: 'Minimum billing adjustment (' + R.minHours + ' h minimum)', amount: money((R.minHours - hours) * R.hourlyRate) });
    if (R.landingFee > 0) items.push({ label: 'Landing fees (' + legs.length + ' landings)', amount: money(legs.length * R.landingFee) });
    if (R.useExtras) for (const e of adjGround(cfg.extras[type] || [], opts)) items.push({ label: e.label, amount: e.amount });
    const list = items.filter(i => i.amount > 0), serviceTotal = list.reduce((s, i) => s + i.amount, 0), fee = money(serviceTotal * cfg.feePct / 100), gst = money(fee * cfg.gstPct / 100);
    return { items: list, serviceTotal, feePct: cfg.feePct, fee, gstPct: cfg.gstPct, gst, total: serviceTotal + fee + gst, hours: +hours.toFixed(2), _op: opId };
  }

  // ---------- track points ----------
  const info = new Map();     // bookingId -> { model, callsign } from the ADS-B signal (shown to the client when the aircraft is tapped)
  const latest = new Map();   // bookingId -> newest position [time, lat, lng, speed, alt] (memory), so the map can update every second
  const trFile = id => path.join(TR, String(id).replace(/[^A-Za-z0-9]/g, '') + '.json');
  // SPEED: the trail is kept in memory (loaded from its file once) instead of reading and parsing the whole file every second.
  const trMem = new Map();
  const readTrack = id => { let l = trMem.get(id); if (!l) { l = rd(trFile(id), []); if (!Array.isArray(l)) l = []; trMem.set(id, l); } return l; };
  function addPoint(id, p) {
    const pt5 = [Date.now(), +p.lat.toFixed(5), +p.lng.toFixed(5), Math.round(p.speedKmh || 0), Math.round(p.alt || 0), Number.isFinite(p.trk) ? Math.round(p.trk * 10) / 10 : null];   // 6th value = real flight direction (degrees) from ADS-B
    latest.set(id, pt5);                                          // live position: updated on every reading
    const l = readTrack(id), last = l[l.length - 1];
    if (last && Date.now() - last[0] < 3000) return;              // the saved path (trail file) gets one point every 3 seconds
    l.push(pt5); if (l.length > 5000) l.splice(0, l.length - 5000);
    fs.mkdirSync(TR, { recursive: true }); fs.writeFile(trFile(id), JSON.stringify(l), () => {});   // written in the background, does not block the server
  }

  // simulated legs land by themselves when their (sped-up) time is over. Returns true if the booking changed.
  function tick(bk) {
    const f = bk.flight; if (!f || f.final) return false; let ch = false;
    const R = ratesOf(f);
    for (const l of f.legs) if (l.simFactor && l.startedAt && !l.endedAt) {
      const need = plannedHours(f, l, R) * 36e5 / l.simFactor;
      if (Date.now() - l.startedAt >= need) { l.endedAt = l.startedAt + Math.round(need); ch = true; }
    }
    return ch;
  }

  function where(bk) {   // current position of the aircraft
    const f = bk.flight, R = ratesOf(f), cur = f.legs.find(l => l.startedAt && !l.endedAt);
    const ended = f.legs.filter(l => l.endedAt), lastEnded = ended[ended.length - 1];
    if (cur && cur.simFactor) {
      const ph = plannedHours(f, cur, R), p = Math.min(1, (Date.now() - cur.startedAt) * cur.simFactor / 36e5 / Math.max(ph, 1e-6));
      return { ...lerp(cur.from, cur.to, p), speedKmh: Math.round(R.avgSpeedKmh), alt: 0, at: Date.now(), source: 'demo' };
    }
    const tr = readTrack(bk.id), lt = tr[tr.length - 1], lm = latest.get(bk.id), last = lm && (!lt || lm[0] > lt[0]) ? lm : lt;
    if (last && (!lastEnded || last[0] > lastEnded.endedAt || cur)) return { lat: last[1], lng: last[2], speedKmh: last[3], alt: last[4], heading: Number.isFinite(last[5]) ? last[5] : null, at: last[0], source: 'gps' };
    if (cur) return { ...cur.from, speedKmh: 0, alt: 0, at: cur.startedAt, source: 'last-known' };
    const g = lastEnded ? lastEnded.to : f.base; return { lat: g.lat, lng: g.lng, speedKmh: 0, alt: 0, at: lastEnded ? lastEnded.endedAt : f.createdAt, source: 'ground' };
  }

  function eta(bk, pos) {   // minutes to pickup and to destination, recalculated from the live position
    const f = bk.flight, R = ratesOf(f), pos0 = f.legs.find(l => l.type === 'patient'), pre = f.legs.find(l => l.type === 'positioning');
    if (f.final || !pos0) return { toPickupMin: null, toDestMin: null };
    const spd = pos.speedKmh > 60 ? pos.speedKmh : R.avgSpeedKmh, rem = (a, b) => distKm(a, b) * R.routeFactor / spd * 60;
    const patientMin = pos0.endedAt ? 0 : pos0.startedAt ? rem(pos, pos0.to) : plannedHours(f, pos0, R) * 60;
    let toPickup = null, toDest = null;
    if (pre && !pre.endedAt) { toPickup = pre.startedAt ? rem(pos, pre.to) : plannedHours(f, pre, R) * 60; toDest = toPickup + R.groundMin + patientMin; }
    else { toPickup = 0; toDest = pos0.startedAt ? patientMin : (pos0.endedAt ? 0 : R.groundMin + patientMin); }
    return { toPickupMin: Math.round(toPickup), toDestMin: Math.round(toDest) };
  }

  function stateText(bk) {   // plain words for the customer
    const f = bk.flight; if (f.final) { const pend = f.final.review && f.final.review.status === 'pending'; return { code: 'done', text: pend ? 'Mission completed. Final bill is being prepared.' : 'Mission completed. Final bill is ready.' }; }
    const cur = f.legs.find(l => l.startedAt && !l.endedAt);
    if (cur) return cur.type === 'positioning' ? { code: 'to_pickup', text: 'Aircraft is on its way to your pickup point.' }
      : cur.type === 'patient' ? { code: 'to_dest', text: 'Patient is on board. Flying to the destination.' }
      : cur.type === 'return' ? { code: 'returning', text: 'Patient delivered. Aircraft is returning to base.' } : { code: 'flying', text: 'Aircraft is flying to the next stop.' };
    const ended = f.legs.filter(l => l.endedAt), last = ended[ended.length - 1];
    if (!last) return { code: 'planned', text: 'Aircraft is being prepared at base.' };
    if (last.type === 'positioning') return { code: 'at_pickup', text: 'Aircraft has landed at the pickup point. Patient boarding.' };
    if (last.type === 'patient') return { code: 'at_dest', text: 'Landed at the destination. Patient is being handed over.' };
    return { code: 'ground', text: 'Aircraft is on the ground.' };
  }

  function legsView(bk) {
    const f = bk.flight, R = ratesOf(f), b = bill(bk, 'actual'), now = Date.now();
    return f.legs.map((l, i) => { const it = b.items.find(x => x.legId === l.id);
      return { id: l.id, type: l.type, from: l.from, to: l.to, plannedKm: +(distKm(l.from, l.to) * R.routeFactor).toFixed(0), takeoff: l.startedAt || null, landed: l.endedAt || null,
        state: l.endedAt ? 'done' : l.startedAt ? 'flying' : 'planned', hours: +legHours(f, l, R, now).toFixed(2), amount: it ? it.amount : 0,
        demo: !!l.simFactor, takeoffClock: l.startedAt ? (l.simFactor ? 'demo' : '') : '' }; });
  }

  function summary(bk, admin) {
    const f = bk.flight, pos = where(bk), tr = readTrack(bk.id), step = Math.max(1, Math.ceil(tr.length / 250));
    const paid = bk.payment ? (bk.payment.total || bk.payment.amount || 0) : 0, est = bill(bk, 'estimate'), act = f.final || bill(bk, 'actual');
    const op = opView(f.operatorId || bk.operatorId), ai = info.get(bk.id) || {};
    const fin = f.final, pending = !!(fin && fin.review && fin.review.status === 'pending'), showBill = !!admin || (!!fin && !pending);   // the customer never sees a bill the admin has not approved
    const out = { id: bk.id, aircraftType: TYPES[f.aircraft], tail: f.tail, operatorName: op ? op.name : '', aircraft: { model: ai.model || '', callsign: ai.callsign || '' }, state: stateText(bk), position: pos, eta: eta(bk, pos), demo: f.legs.some(l => l.simFactor),
      places: { base: f.base, pickup: f.pickup, drop: f.drop }, legs: legsView(bk), trail: tr.filter((_, i) => i % step === 0).map(p => [p[1], p[2]]),
      estimate: showBill ? est : null, bill: showBill ? act : null, final: !!f.final, billStatus: !fin ? 'live' : pending ? 'pending' : 'approved', paid, balance: showBill ? act.total - paid : null, auto: !!f.auto, seen: seen.get(bk.id) || 0, updatedAt: Date.now() };
    if (admin && fin) { out.review = fin.review || { status: 'approved' }; out.billLog = fin.log || []; }
    if (admin) { out.feedKey = f.feedKey; out.status = bk.status; out.name = bk.name; out.phone = bk.phone; out.operator = opView(f.operatorId || bk.operatorId); }
    return out;
  }


  // ---------- AUTO TRACKING: the aircraft is found by its registration number on the public ADS-B network (adsb.lol).
  // No phone or app is needed. If the aircraft transponder is off or out of range, the customer page says "waiting for signal"
  // and the Traccar feed / manual position below still work as a backup.
  const ADSB_SRC = [['adsb.lol', 'https://api.adsb.lol/v2/reg/'], ['airplanes.live', 'https://api.airplanes.live/v2/reg/']], seen = new Map(), st = new Map();   // bookingId -> last time seen / take-off + landing counters (memory only)
  async function adsbFetch(reg) {   // asks adsb.lol first; if it is busy (HTTP 429) or does not know the aircraft, asks airplanes.live (same data format)
    let err = null;
    for (const [name, base] of ADSB_SRC) {
      try {
        const r = await fetch(base + encodeURIComponent(reg), { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'GharToHealth-air-tracking' } });
        if (!r.ok) { err = new Error(name + ' replied HTTP ' + r.status + (r.status === 429 ? ' (too many requests)' : '')); continue; }
        const j = await r.json(), a = j && Array.isArray(j.ac) ? j.ac.find(x => x && Number.isFinite(+x.lat) && Number.isFinite(+x.lon)) : null;
        if (!a) continue;
        const ground = a.alt_baro === 'ground';
        return { lat: +a.lat, lng: +a.lon, speedKmh: (Number(a.gs) || 0) * 1.852, alt: ground ? 0 : (Number(a.alt_baro) || 0) * 0.3048, ground, trk: Number.isFinite(+a.track) ? +a.track : (Number.isFinite(+a.true_heading) ? +a.true_heading : null), model: String(a.desc || a.t || '').slice(0, 40), callsign: String(a.flight || '').trim().slice(0, 12) };
      } catch (e) { err = new Error(name + ': ' + e.message); }
    }
    if (err) throw err;   // every source failed: the log shows the real reason
    return null;          // sources answered but do not see this aircraft right now
  }
  // take-off = in the air at speed for 2 readings in a row; landing = "on ground" for 3 readings in a row. Returns true if the booking changed.
  const bump = (id, p) => { const s = st.get(id) || { air: 0, gnd: 0 }; s.air = (!p.ground && p.speedKmh > 50) ? s.air + 1 : 0; s.gnd = p.ground ? s.gnd + 1 : 0; st.set(id, s); return s; };
  function autoLegs(bk, p) {
    const f = bk.flight, s = st.get(bk.id) || bump(bk.id, p);   // the readings are counted in bump() before this is called
    const cur = f.legs.find(l => l.startedAt && !l.endedAt), next = f.legs.find(l => !l.startedAt), hist = t => (bk.history = bk.history || []).push({ at: new Date().toISOString(), event: t });
    if (!cur && next && s.air >= 2) { next.startedAt = Date.now(); hist('Take-off seen on aircraft signal: ' + next.from.name + ' to ' + next.to.name); return true; }
    if (cur && s.gnd >= 3) { cur.endedAt = Date.now(); hist('Landing seen on aircraft signal: ' + cur.to.name); return true; }
    return false;
  }
  let polling = false;
  const nextTry = new Map();   // tail -> earliest time for the next adsb.lol request (one request per aircraft every 6 s, 45 s pause after an error)
  const warned = new Map(), warnOnce = (k, t) => { if (Date.now() - (warned.get(k) || 0) > 60000) { warned.set(k, Date.now()); console.log(t); } };   // one log line per minute, not every 5 seconds
  // SPEED: this runs every second. Before, it read and parsed the whole bookings.json every second (even with no flight running)
  // and asked adsb.lol for one aircraft after another. Now the list of tracked flights is refreshed every 10 seconds (or at once
  // after the admin starts / changes a mission), aircraft are asked in parallel, and bookings.json is read again ONLY when a
  // take-off or landing has to be saved.
  let jobs = { at: 0, l: [] };
  async function pollAll() {
    if (polling) return; polling = true;
    try {
      if (Date.now() - jobs.at > 10000) jobs = { at: Date.now(), l: c.readBookings().filter(b => b.flight && !b.flight.final && b.flight.auto && b.flight.tail)
        .map(b => ({ id: b.id, tail: b.flight.tail, cur: b.flight.legs.some(l => l.startedAt && !l.endedAt), next: b.flight.legs.some(l => !l.startedAt) })) };
      if (!jobs.l.length) return;
      const got = {};
      for (const j of jobs.l) {   // one request at a time (no bursts), each aircraft at most every 6 s, 45 s pause after an error
        if (Date.now() < (nextTry.get(j.tail) || 0)) continue; nextTry.set(j.tail, Date.now() + 6000);
        try { const p = await adsbFetch(j.tail); if (p) got[j.id] = p; else warnOnce(j.id + 'np', '[air-track] ' + j.tail + ': no position for this registration right now (not seen by any source)'); }
        catch (e) { nextTry.set(j.tail, Date.now() + 45000); warnOnce(j.id + 'er', '[air-track] ' + j.tail + ': ' + e.message); }
      }
      let need = false;
      for (const j of jobs.l) { const p = got[j.id]; if (!p) continue;
        seen.set(j.id, Date.now()); if (p.model || p.callsign) info.set(j.id, { model: p.model, callsign: p.callsign }); addPoint(j.id, p);
        const s = bump(j.id, p); if ((!j.cur && j.next && s.air >= 2) || (j.cur && s.gnd >= 3)) need = true; }
      if (!need) return;
      const list = c.readBookings(); let changed = false;   // read again after the waiting, so no other change is overwritten
      for (const bk of list) { const p = got[bk.id]; if (!p || !bk.flight || bk.flight.final) continue; if (autoLegs(bk, p)) changed = true; }
      if (changed) c.saveBookings(list);
      jobs.at = 0;   // take-off / landing happened: refresh the list at once
    } catch (e) { console.log('Air auto-tracking:', e.message); } finally { polling = false; }
  }
  setInterval(pollAll, 1000).unref();   // aircraft position is fetched every second

  const prep = (b) => ({ tail: c.clean(b.tail, 12).toUpperCase().replace(/[^A-Z0-9-]/g, '') });

  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/api/air/')) return false;
    const done = (s, o) => { c.send(res, s, o); return true; }, POST = req.method === 'POST';
    const body = async () => { try { return await c.readBody(req, 20000); } catch { return {}; } };
    const isAdmin = () => req.headers['x-admin-key'] === c.ADMIN_KEY;
    const getBk = (list, id) => list.find(y => y.id === c.clean(id, 30).toUpperCase());

    // ----- operator GPS feed (Traccar Client app, GPS tracker or pilot phone). Key = the mission's feed key.
    if (p === '/api/air/feed') {
      const q = url.searchParams, b = POST ? await body() : {}, g = k => (b[k] !== undefined ? b[k] : q.get(k));
      const key = String(g('key') || g('id') || ''), list = c.readBookings(), bk = list.find(y => y.flight && same(y.flight.feedKey, key));
      if (!bk) return done(403, { error: 'Invalid key' });
      if (bk.flight.final) return done(200, { ok: true, ignored: 'mission finished' });
      const lat = Number(g('lat')), lng = Number(g('lng') !== null && g('lng') !== undefined ? g('lng') : g('lon'));
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180) || (lat === 0 && lng === 0)) return done(400, { error: 'Bad position' });
      const kmh = g('speedKmh') !== null && g('speedKmh') !== undefined ? Number(g('speedKmh')) : Number(g('speed') || 0) * 1.852; // plain "speed" = knots (Traccar/OsmAnd)
      addPoint(bk.id, { lat, lng, speedKmh: Number.isFinite(kmh) ? kmh : 0, alt: Number(g('altitude') || g('alt') || 0) || 0 });
      return done(200, { ok: true });
    }

    // ----- customer: booking ID + mobile number
    if (p === '/api/air/track' && POST) {
      const b = await body(), ph = c.clean(b.phone, 15).replace(/\D/g, '').slice(-10), list = c.readBookings();
      const bk = list.find(y => y.id === c.clean(b.id, 30).toUpperCase() && String(y.phone).slice(-10) === ph && y.flight);
      if (!bk) return done(404, { error: 'Live tracking is not available for this booking yet. Check the ID and mobile number, or ask us to start tracking.' });
      if (tick(bk)) c.saveBookings(list);
      return done(200, summary(bk, false));
    }

    // ----- PUBLIC: operator application form (no admin key). Step 1 creates the operator card (Available OFF) and returns an application id + token.
    if (p === '/api/air/operator-apply' && POST) {
      if (!rateOk(req, 'applytry', 40)) return done(429, { error: 'Too many attempts from this device. Please try again after some time.' });   // wrong entries also count here, so the limit is loose
      let b; try { b = await c.readBody(req, 3.5e6); } catch { return done(413, { error: 'The photos are too large. Please use smaller photos.' }); }
      b = b && typeof b === 'object' ? b : {};
      const name = c.clean(b.name, 60), person = c.clean(b.person, 60), phone = c.clean(b.phone, 15).replace(/[\s-]/g, ''), email = c.clean(b.email, 80),
        aircraft = String(b.aircraft || ''), reg = regOf(b.reg), base = pt(b.base, b.base && b.base.name);
      if (name.length < 2) return done(400, { error: 'Enter the company / operator name.' });
      if (person.length < 2) return done(400, { error: 'Enter the contact person name.' });
      if (!/^(\+91)?[6-9]\d{9}$/.test(phone)) return done(400, { error: 'Enter a valid 10-digit mobile number.' });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return done(400, { error: 'The email address does not look right.' });
      if (!TYPES[aircraft]) return done(400, { error: 'Choose Helicopter or Charter aircraft.' });
      if (reg.length < 4) return done(400, { error: 'Enter the aircraft registration number.' });
      if (!base || base.name.length < 2) return done(400, { error: 'Pick the base airport from the list (or paste coordinates).' });
      if (b.declared !== true) return done(400, { error: 'Please tick the declaration.' });
      const rates = {}, rin = b.rates && typeof b.rates === 'object' ? b.rates : {};
      for (const k of Object.keys(LIMITS)) { const raw = rin[k], v = raw === undefined ? DEF_BY_TYPE[aircraft][k] : Number(raw);
        if (raw === '' || raw === null || !(v >= LIMITS[k][0] && v <= LIMITS[k][1])) return done(400, { error: (RLAB[k] || k) + ': enter a value between ' + LIMITS[k][0] + ' and ' + LIMITS[k][1] + '.' });
        rates[k] = v; }
      if (!(rates.hourlyRate > 0)) return done(400, { error: 'Enter your hourly rate.' });
      const aad = imgOf(b.aadhaar), pan = imgOf(b.pan);
      if (!aad || !pan) return done(400, { error: 'Aadhaar and PAN must be JPG or PNG photos under 2.5 MB.' });
      const ops = getOps(), apps = rdApps();
      if (ops.some(o => o.reg && o.reg === reg)) return done(400, { error: 'An operator with this aircraft registration is already listed with us. Please call us.' });
      if (ops.length >= 30 || ops.filter(o => !o.active && apps[o.id]).length >= 20) return done(503, { error: 'We are not taking new applications right now. Please call us.' });
      if (!rateOk(req, 'apply', 5)) return done(429, { error: 'Too many applications from this device. Please try again after some time.' });   // only real applications count here
      const id = 'OP' + crypto.randomBytes(4).toString('hex'), token = crypto.randomBytes(16).toString('hex'), now = Date.now();
      fs.mkdirSync(DOC_DIR, { recursive: true });
      fs.writeFileSync(path.join(DOC_DIR, id + '-aadhaar.' + aad.ext), aad.buf); fs.writeFileSync(path.join(DOC_DIR, id + '-pan.' + pan.ext), pan.buf);
      const raw = rd(OP_FILE, []), list = Array.isArray(raw) ? raw : [];
      list.push({ id, name, phone, note: ('Applied online ' + new Date(now + 19800000).toISOString().slice(0, 10) + '. Contact: ' + person + (email ? ', ' + email : '')).slice(0, 200),
        reg, aircraft, active: false, rates, base, createdAt: now });
      fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(OP_FILE, JSON.stringify(list, null, 2));
      apps[id] = { person, email, token: sha(token), at: new Date(now).toISOString(), ids: { aadhaar: aad.ext, pan: pan.ext } }; wrApps(apps);
      console.log('[air-operator] new online application ' + id + ': ' + name + ' (' + TYPES[aircraft] + ', ' + reg + ')');
      try { if (c.notifyApplication) c.notifyApplication(id, name, TYPES[aircraft]); } catch {}
      return done(200, { ok: true, id, token });
    }
    // Step 2: the applicant uploads each document (file + expiry date). Needs the id + token from step 1, works for 48 hours, and cannot replace a document the admin already verified.
    if (p === '/api/air/operator-apply-doc' && POST) {
      if (!rateOk(req, 'applydoc', 40)) return done(429, { error: 'Too many uploads from this device. Please try again after some time.' });
      let b; try { b = await c.readBody(req, 4e6); } catch { return done(413, { error: 'File too large (max 2.5 MB).' }); }
      b = b && typeof b === 'object' ? b : {};
      const id = c.clean(b.id, 40).replace(/[^A-Za-z0-9]/g, ''), k = String(b.key || ''), apps = rdApps(), a = apps[id];
      if (!a || !same(a.token, sha(b.token))) return done(403, { error: 'This application is not valid. Please submit the form again.' });
      if (Date.now() - Date.parse(a.at) > APP_HOURS * 36e5) return done(403, { error: 'Uploads for this application are closed. Please call us.' });
      if (!getOps().some(o => o.id === id)) return done(404, { error: 'This application is no longer open. Please call us.' });
      if (!OP_DOCS.some(r => r[0] === k)) return done(400, { error: 'Invalid document.' });
      const ex = String(b.expiry || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(ex) || ex < todayIN()) return done(400, { error: 'Enter a valid expiry date (today or a future date).' });
      const dm = rdDocs(), set = dm[id] = dm[id] || {};
      if (set[k] && set[k].status === 'verified') return done(400, { error: 'This document is already verified by our team.' });
      const e = saveOpDoc(id, k, b.file); if (!e) return done(400, { error: 'The file must be a JPG, PNG or PDF (max 2.5 MB).' });
      set[k] = { ext: e, expiry: ex, status: 'pending', at: new Date().toISOString() }; wrDocs(dm);
      return done(200, { ok: true });
    }

    // ----- everything below is admin only
    if (!isAdmin()) return done(401, { error: 'Wrong admin key' });

    // ----- admin: review, edit and approve the final bill. The customer sees the bill only after approval.
    if (p === '/api/air/admin-bill' && POST) {
      const b = await body(), list = c.readBookings(), bk = getBk(list, b.id), f = bk && bk.flight, fin = f && f.final;
      if (!fin) return done(404, { error: 'Final bill is not created yet. Complete the mission first.' });
      fin.review = fin.review || { status: 'approved' }; fin.log = fin.log || [];
      if (fin.review.status !== 'pending') return done(400, { error: 'This bill is already approved and the client can see it.' });
      const act = String(b.action || ''), hist = t => (bk.history = bk.history || []).push({ at: new Date().toISOString(), event: t });
      const logIt = what => { fin.log.push({ at: Date.now(), by: 'admin', what }); hist('Bill: ' + what); };
      if (act === 'save') {
        const amts = Array.isArray(b.amounts) ? b.amounts : [], note = c.clean(b.note, 300), changes = [], next = [];
        for (let i = 0; i < fin.items.length; i++) {
          const raw = amts[i], it = fin.items[i];
          if (raw === undefined || raw === null || raw === '') { next.push(it.amount); continue; }
          const v = Math.round(Number(raw));
          if (!(v >= 0 && v <= 1e8)) return done(400, { error: 'Enter a valid amount (0 or more) for: ' + it.label });
          next.push(v); if (v !== it.amount) changes.push(it.label + ': Rs ' + it.amount + ' to Rs ' + v);
        }
        if (!changes.length) return done(400, { error: 'Nothing was changed.' });
        if (note.length < 3) return done(400, { error: 'Write a short note: why did you change the bill?' });
        fin.items.forEach((it, i) => { if (next[i] !== it.amount) { if (it.origAmount == null) it.origAmount = it.amount; it.amount = next[i]; } });
        fin.serviceTotal = fin.items.reduce((s, i) => s + i.amount, 0);
        fin.fee = money(fin.serviceTotal * fin.feePct / 100); fin.gst = money(fin.fee * fin.gstPct / 100);
        fin.total = fin.serviceTotal + fin.fee + fin.gst; fin.balance = fin.total - (fin.paid || 0);
        logIt('Edited: ' + changes.join('; ') + ' | New total Rs ' + fin.total + ' | Note: ' + note);
      } else if (act === 'approve') {
        if (fin.review.needsReview && !b.confirm) return done(400, { error: 'This bill is much higher than the estimate. Confirm to approve it.' });
        fin.review = { ...fin.review, status: 'approved', at: Date.now() };
        logIt('Approved: total Rs ' + fin.total + ', paid Rs ' + (fin.paid || 0) + ', ' + (fin.balance >= 0 ? 'balance Rs ' + fin.balance : 'refund Rs ' + (-fin.balance)));
      } else return done(400, { error: 'Unknown action.' });
      c.saveBookings(list); return done(200, { ok: true });
    }

    if (p === '/api/air/admin-rates') {
      if (req.method === 'GET') return done(200, { rates: getRates(), types: TYPES, limits: LIMITS });
      if (req.method === 'PUT') {
        const b = await body(), cur = getRates(), out = {};
        for (const t of Object.keys(TYPES)) { out[t] = {};
          for (const k of Object.keys(LIMITS)) { const v = Number(b.rates && b.rates[t] && b.rates[t][k]);
            if (!(v >= LIMITS[k][0] && v <= LIMITS[k][1])) return done(400, { error: TYPES[t] + ' - ' + k + ': value must be between ' + LIMITS[k][0] + ' and ' + LIMITS[k][1] + '.' });
            out[t][k] = v; } }
        fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(RATE_FILE, JSON.stringify(out, null, 2)); return done(200, { ok: true });
      }
    }


    if (p === '/api/air/admin-operator-doc') {   // documents of one operator: GET = view the file, POST = upload / change expiry / verify
      if (req.method === 'GET') {
        const id = c.clean(url.searchParams.get('id'), 40).replace(/[^A-Za-z0-9]/g, ''), k = url.searchParams.get('key');
        if (k === 'aadhaar' || k === 'pan') {   // identity photos sent with the online application
          const ext = (((rdApps()[id] || {}).ids) || {})[k];
          if (!ext) return done(404, { error: 'No document' });
          try { c.send(res, 200, fs.readFileSync(path.join(DOC_DIR, id + '-' + k + '.' + ext)), { 'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store' }); return true; }
          catch { return done(404, { error: 'File missing' }); }
        }
        const d = (rdDocs()[id] || {})[k];
        if (!d || !OP_DOCS.some(r => r[0] === k)) return done(404, { error: 'No document' });
        try { c.send(res, 200, fs.readFileSync(path.join(DOC_DIR, id + '-' + k + '.' + d.ext)), { 'Content-Type': d.ext === 'pdf' ? 'application/pdf' : d.ext === 'png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store' }); return true; }
        catch { return done(404, { error: 'File missing' }); }
      }
      if (POST) {
        let b; try { b = await c.readBody(req, 4e6); } catch { return done(413, { error: 'File too large (max 2.5 MB).' }); }
        const id = c.clean(b.id, 40).replace(/[^A-Za-z0-9]/g, ''), k = String(b.key || '');
        if (!getOps().some(o => o.id === id)) return done(404, { error: 'Operator not found. Save the operator first.' });
        if (!OP_DOCS.some(r => r[0] === k)) return done(400, { error: 'Invalid document.' });
        const dm = rdDocs(), set = dm[id] = dm[id] || {}, old = set[k], ex = b.expiry === undefined ? undefined : String(b.expiry);
        if (ex !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(ex) || ex < todayIN())) return done(400, { error: 'Enter a valid expiry date (today or a future date).' });
        if (b.file && !ex && !(old && old.expiry)) return done(400, { error: 'Enter the expiry date.' });
        let d = old;
        if (b.file) {
          const e = saveOpDoc(id, k, b.file);
          if (!e) return done(400, { error: 'The file must be a JPG, PNG or PDF (max 2.5 MB).' });
          d = set[k] = { ext: e, expiry: ex || (old && old.expiry) || '', status: 'pending', at: new Date().toISOString() };
        } else if (!d) return done(400, { error: 'Upload the file first.' });
        else if (ex !== undefined && ex !== d.expiry) { d.expiry = ex; d.status = 'pending'; delete d.verifiedAt; }
        if (typeof b.verify === 'boolean') {
          if (b.verify && (!d.expiry || d.expiry < todayIN())) return done(400, { error: 'A valid expiry date is required before verifying.' });
          d.status = b.verify ? 'verified' : 'pending'; if (b.verify) d.verifiedAt = new Date().toISOString(); else delete d.verifiedAt;
        }
        wrDocs(dm); return done(200, { ok: true });
      }
    }

    if (p === '/api/air/admin-operators') {   // the operator list (order = priority: top operator is offered first)
      if (req.method === 'GET') {
        const busy = busyMap(true), holds = holdsNow();
        return done(200, { types: TYPES, now: Date.now(), operators: getOps().map(o => { const h = holds.find(x => x.opId === o.id);
          return { ...o, docs: docView(o.id), app: appView(o.id), busyWith: busy[o.id] || (h ? h.ref + ' (payment pending)' : '') }; }) });
      }
      if (req.method === 'PUT') {
        const b = await body(), list = Array.isArray(b.operators) ? b.operators : [], old = getOps(), out = [], seen = {};
        if (list.length > 30) return done(400, { error: 'Maximum 30 operators.' });
        for (const x of list) {
          const name = c.clean(x && x.name, 60), aircraft = x && x.aircraft;
          if (!name) return done(400, { error: 'Every operator needs a name.' });
          if (!TYPES[aircraft]) return done(400, { error: name + ': choose Charter aircraft or Helicopter.' });
          const rates = {};
          for (const k of Object.keys(LIMITS)) { const raw = x.rates ? x.rates[k] : undefined, v = (raw === undefined) ? DEF_BY_TYPE[aircraft][k] : Number(raw);
            if (!(v >= LIMITS[k][0] && v <= LIMITS[k][1]) || raw === '' || raw === null) return done(400, { error: name + ' - ' + k + ': value must be between ' + LIMITS[k][0] + ' and ' + LIMITS[k][1] + '.' });
            rates[k] = v; }
          let id = c.clean(x.id, 40).replace(/[^A-Za-z0-9]/g, ''); if (!id || seen[id]) id = 'OP' + crypto.randomBytes(4).toString('hex'); seen[id] = 1;
          const was = old.find(o => o.id === id);
          out.push({ id, name, phone: c.clean(x.phone, 15).replace(/[^0-9+]/g, ''), note: c.clean(x.note, 200), reg: regOf(x.reg), aircraft, active: x.active !== false, rates,
            base: pt(x.base, x.base && x.base.name), createdAt: (was && was.createdAt) || Date.now() });
        }
        // Operators that applied online AFTER this admin page was opened are kept, so Saving from an older page can never delete a new application.
        const la = Number(b.loadedAt);
        if (Number.isFinite(la) && la > 0) old.forEach(o => { if (o.createdAt > la && !out.some(x => x.id === o.id)) out.push({ id: o.id, name: o.name, phone: o.phone, note: o.note, reg: o.reg, aircraft: o.aircraft, active: o.active, rates: o.rates, base: o.base, createdAt: o.createdAt }); });
        fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(OP_FILE, JSON.stringify(out, null, 2));
        try { const ap = rdApps(), keepA = new Set(out.map(o => o.id)); let chA = false;   // remove the application details and ID photos of operators the admin removed
          for (const oid of Object.keys(ap)) if (!keepA.has(oid)) { delete ap[oid]; chA = true; try { fs.readdirSync(DOC_DIR).filter(f => f.startsWith(oid + '-')).forEach(f => fs.unlinkSync(path.join(DOC_DIR, f))); } catch {} }
          if (chA) wrApps(ap); } catch {}
        try { const dm = rdDocs(), keep = new Set(out.map(o => o.id)); let ch = false;
          for (const oid of Object.keys(dm)) if (!keep.has(oid)) { delete dm[oid]; ch = true; try { fs.readdirSync(DOC_DIR).filter(f => f.startsWith(oid + '-')).forEach(f => fs.unlinkSync(path.join(DOC_DIR, f))); } catch {} }
          if (ch) wrDocs(dm); } catch {}
        return done(200, { ok: true });
      }
    }


    // ----- choose the operator of a booking by hand (or 'auto' = first free operator from the top). Only operators from Air Ambulance Charges.
    if (p === '/api/air/admin-assign' && POST) {
      const b = await body(), list = c.readBookings(), bk = getBk(list, b.id);
      if (!bk || !TYPES[bk.ambType]) return done(404, { error: 'Helicopter / charter booking not found.' });
      if (bk.status === 'cancelled' || bk.status === 'completed') return done(400, { error: 'This booking is already closed.' });
      // Real (paid) bookings are locked once live tracking starts (the bill depends on the operator's rates). Demo / test bookings can always be changed: the demo mission is reset.
      if (bk.flight && !isDemoBk(bk)) return done(400, { error: 'Live tracking has already started for this paid booking, so the operator cannot be changed now.' });
      const busy = busyMap(true), others = holdsNow().filter(h => h.ref !== bk.id), free = o => isReady(o) && o.aircraft === bk.ambType && (!busy[o.id] || busy[o.id] === bk.id) && !others.some(h => h.opId === o.id);
      const want = c.clean(b.operatorId, 40), ops = getOps(), op = (!want || want === 'auto') ? rankOps(bk, ops.filter(free), list)[0] : ops.find(o => o.id === want);
      if (!op) return done(400, { error: 'No free ' + TYPES[bk.ambType] + ' operator is ready right now.' });
      if (!free(op)) return done(400, { error: op.name + ' cannot be used: ' + (op.aircraft !== bk.ambType ? 'wrong aircraft type.' : !isReady(op) ? 'not ready (needs all documents verified, hourly rate and base airport, and "Available" ticked).' : 'busy with another booking.') });
      const was = bk.operatorId; bk.operatorId = op.id;
      if (bk.flight) { delete bk.flight; (bk.history = bk.history || []).push({ at: new Date().toISOString(), event: 'Demo mission reset because the operator was changed' }); jobs.at = 0; }
      (bk.history = bk.history || []).push({ at: new Date().toISOString(), event: 'Air operator ' + (want && want !== 'auto' ? 'chosen by admin: ' : 'auto-assigned: ') + op.name + (op.phone ? ' (' + op.phone + ')' : '') + (was && was !== op.id ? ' (changed from the earlier operator)' : '') });
      c.saveBookings(list); return done(200, { ok: true, operator: opView(op.id) });
    }
    // ----- dropdown data: every operator of this booking's aircraft type, best match first, with the reason when one cannot be chosen.
    if (p === '/api/air/admin-assign-options' && req.method === 'GET') {
      const list = c.readBookings(), bk = getBk(list, url.searchParams.get('id'));
      if (!bk || !TYPES[bk.ambType]) return done(404, { error: 'Helicopter / charter booking not found.' });
      const busy = busyMap(true), others = holdsNow().filter(h => h.ref !== bk.id), pk = fromMapUrl(bk.maps && bk.maps.pickup);
      const all = getOps().filter(o => o.aircraft === bk.ambType), ok = o => isReady(o) && (!busy[o.id] || busy[o.id] === bk.id) && !others.some(h => h.opId === o.id);
      const best = rankOps(bk, all.filter(ok), list)[0], order = rankOps(bk, all, list);
      const reason = o => !o.active ? 'Not available (switched off)' : !docsOk(o) ? 'Documents incomplete / not verified' : !o.base ? 'Base airport missing' : !(o.rates.hourlyRate > 0) ? 'Hourly rate missing' : (busy[o.id] && busy[o.id] !== bk.id) ? 'Busy with ' + busy[o.id] : others.some(h => h.opId === o.id) ? 'Held for another client (payment pending)' : '';
      return done(200, { booking: bk.id, aircraft: TYPES[bk.ambType], current: bk.operatorId || '', locked: !!(bk.flight && !isDemoBk(bk)), demoReset: !!(bk.flight && isDemoBk(bk)), closed: bk.status === 'cancelled' || bk.status === 'completed',
        auto: best ? { id: best.id, name: best.name } : null,
        operators: order.map(o => ({ id: o.id, name: o.name, phone: o.phone, base: o.base ? o.base.name : '', distanceKm: (pk && o.base) ? Math.round(distKm(o.base, pk)) : null, canChoose: ok(o), reason: reason(o), best: !!best && best.id === o.id })) });
    }
    if (p === '/api/air/admin-auto-assign' && POST) {
      const list = c.readBookings(), busy = busyMap(true), holds = holdsNow(), ops = getOps().filter(isReady); let n = 0, left = 0;
      for (const bk of list) {
        if (!(bk.type === 'medical' && TYPES[bk.ambType] && bk.payment && !bk.operatorId && bk.status !== 'cancelled' && bk.status !== 'completed')) continue;
        const op = rankOps(bk, ops.filter(o => o.aircraft === bk.ambType && !busy[o.id] && !holds.some(h => h.opId === o.id && h.ref !== bk.id)), list)[0];
        if (!op) { left++; continue; }
        bk.operatorId = op.id; busy[op.id] = bk.id; n++;
        (bk.history = bk.history || []).push({ at: new Date().toISOString(), event: 'Air operator auto-assigned: ' + op.name + (op.phone ? ' (' + op.phone + ')' : '') });
      }
      if (n) c.saveBookings(list); return done(200, { ok: true, assigned: n, waiting: left });
    }

    if (p === '/api/air/admin-base') { // base airport of each aircraft type (used for the client's live price)
      if (req.method === 'GET') { const B = getBase(), RR = getRates(), ready = {}; for (const t of Object.keys(TYPES)) ready[t] = !!(B[t] && RR[t] && RR[t].hourlyRate > 0); return done(200, { base: B, ready }); }
      if (req.method === 'PUT') {
        const b = await body(), out = {};
        for (const t of Object.keys(TYPES)) { const v = pt(b.base && b.base[t], b.base && b.base[t] && b.base[t].name); if (v) out[t] = v; }
        fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(BASE_FILE, JSON.stringify(out, null, 2)); return done(200, { ok: true });
      }
    }

    if (p === '/api/air/admin-missions' && req.method === 'GET') {
      const list = c.readBookings(), items = list.filter(y => y.type === 'medical' && TYPES[y.ambType] && y.payment).reverse().slice(0, 60).map(y => {
        const ch = y.flight ? tick(y) : false; if (ch) c.saveBookings(list);
        return { id: y.id, name: y.name, phone: y.phone, aircraft: y.ambType, date: y.date, status: y.status, pickup: y.pickup, drop: y.drop,
          pickupLL: fromMapUrl(y.maps && y.maps.pickup), dropLL: fromMapUrl(y.maps && y.maps.drop), started: !!y.flight, final: !!(y.flight && y.flight.final), tail: y.flight ? y.flight.tail : '', operatorId: y.operatorId || '', operator: opView(y.operatorId) }; });
      return done(200, { items });
    }

    if (p === '/api/air/admin-detail' && req.method === 'GET') {
      const list = c.readBookings(), bk = getBk(list, url.searchParams.get('id'));
      if (!bk || !bk.flight) return done(404, { error: 'Mission not started for this booking.' });
      if (tick(bk)) c.saveBookings(list);
      return done(200, summary(bk, true));
    }

    if (p === '/api/air/admin-start' && POST) {
      const b = await body(), list = c.readBookings(), bk = getBk(list, b.id);
      if (!bk || !TYPES[bk.ambType]) return done(404, { error: 'Helicopter / charter booking not found.' });
      if (bk.flight) return done(400, { error: 'Mission already started for this booking.' });
      const opx = getOps().find(o => o.id === (c.clean(b.operatorId, 40) || bk.operatorId)), tail = prep(b).tail || (opx && opx.reg) || '', bIn = pt(b.base), base = (bIn && bIn.name.length >= 2) ? bIn : ((opx && opx.base) || bIn), pickup = pt(b.pickup, bk.pickup), drop = pt(b.drop, bk.drop);
      if (tail.length < 3) return done(400, { error: 'Enter the aircraft registration number (for example VT-ABC), or save it once on the operator in Air Ambulance Charges.' });
      if (!base || base.name.length < 2) return done(400, { error: 'Enter the aircraft base name and its latitude / longitude.' });
      if (!pickup || !drop) return done(400, { error: 'Pickup and drop need latitude / longitude.' });
      const sim = Math.round(Number(b.demoSpeed) || 0), legs = [['positioning', base, pickup], ['patient', pickup, drop]];
      if (b.includeReturn !== false) legs.push(['return', drop, base]);
      if (opx) { bk.operatorId = opx.id; }
      bk.flight = { aircraft: bk.ambType, operatorId: opx ? opx.id : '', R: opx ? opx.rates : undefined, tail, base, pickup, drop, createdAt: Date.now(), feedKey: crypto.randomBytes(12).toString('hex'), demoFactor: sim >= 2 && sim <= 3000 ? sim : 0, auto: !(sim >= 2 && sim <= 3000),
        legs: legs.map((x, i) => ({ id: 'L' + (i + 1), type: x[0], from: x[1], to: x[2] })), final: null };
      (bk.history = bk.history || []).push({ at: new Date().toISOString(), event: 'Live tracking started, aircraft ' + tail + (opx ? ' (operator ' + opx.name + ')' : '') });
      jobs.at = 0; c.saveBookings(list); return done(200, { ok: true });
    }

    if (p === '/api/air/admin-event' && POST) {
      const b = await body(), list = c.readBookings(), bk = getBk(list, b.id), f = bk && bk.flight;
      if (!f) return done(404, { error: 'Mission not started for this booking.' });
      if (f.final) return done(400, { error: 'Mission is already finalised.' });
      tick(bk); const hist = t => (bk.history = bk.history || []).push({ at: new Date().toISOString(), event: t });
      const cur = f.legs.find(l => l.startedAt && !l.endedAt), nextLeg = f.legs.find(l => !l.startedAt), ev = String(b.event || '');
      if (ev === 'tail') {   // correct the aircraft registration of a running mission (used for live ADS-B tracking)
        const tl = prep(b).tail; if (tl.length < 3) return done(400, { error: 'Enter the aircraft registration number (for example VT-ABC).' });
        const was = f.tail; f.tail = tl; st.delete(bk.id); seen.delete(bk.id);
        hist('Aircraft registration changed: ' + (was || '-') + ' to ' + tl);
      } else if (ev === 'auto') {   // switch a Demo mission to real aircraft tracking (ADS-B). Demo progress is cleared.
        f.auto = true; f.demoFactor = 0; st.delete(bk.id); seen.delete(bk.id);
        f.legs.forEach(l => { if (l.simFactor) { delete l.simFactor; delete l.startedAt; delete l.endedAt; } });
        hist('Switched from demo to live aircraft tracking (' + f.tail + ')');
      } else if (ev === 'takeoff') {
        if (cur) return done(400, { error: 'A leg is already in the air. Press Landed first.' });
        if (!nextLeg) return done(400, { error: 'No leg left to fly. Add a leg or finalise the bill.' });
        nextLeg.startedAt = Date.now(); if (f.demoFactor) nextLeg.simFactor = f.demoFactor;
        hist('Take-off: ' + nextLeg.from.name + ' to ' + nextLeg.to.name + (f.demoFactor ? ' (demo)' : ''));
      } else if (ev === 'land') {
        if (!cur) return done(400, { error: 'No leg is in the air.' });
        cur.endedAt = Date.now(); hist('Landed: ' + cur.to.name);
      } else if (ev === 'position') {
        const q = pt(b), spd = Number(b.speedKmh) || 0;
        if (!q) return done(400, { error: 'Enter a valid latitude and longitude.' });
        addPoint(bk.id, { lat: q.lat, lng: q.lng, speedKmh: spd, alt: Number(b.alt) || 0 });
      } else if (ev === 'add-leg') {
        const from = pt(b.from), to = pt(b.to);
        if (!from || !to || from.name.length < 2 || to.name.length < 2) return done(400, { error: 'Enter name, latitude and longitude for both places.' });
        if (f.legs.length >= 8) return done(400, { error: 'Maximum 8 legs.' });
        f.legs.push({ id: 'L' + (f.legs.length + 1), type: 'extra', from, to }); hist('Extra leg added: ' + from.name + ' to ' + to.name);
      } else if (ev === 'finalize') {
        if (cur) return done(400, { error: 'A leg is still in the air. Press Landed first.' });
        const pat = f.legs.find(l => l.type === 'patient');
        if (!pat || !pat.endedAt) return done(400, { error: 'The patient leg must be landed before the final bill.' });
        const est = bill(bk, 'estimate');   // planned route, taken before unflown legs are dropped
        f.legs = f.legs.filter(l => l.startedAt);   // legs never flown are not billed
        const fb = bill(bk, 'actual'), paid = bk.payment ? (bk.payment.total || bk.payment.amount || 0) : 0;
        const needsReview = !(est.total > 0) || fb.total > est.total * (1 + REVIEW_PCT / 100);
        f.final = { ...fb, mode: 'final', at: Date.now(), paid, balance: fb.total - paid, estimateTotal: est.total,
          review: { status: 'pending', needsReview, reason: needsReview ? 'Final bill Rs ' + fb.total + ' is more than ' + REVIEW_PCT + '% above the estimate Rs ' + est.total : '' },
          log: [{ at: Date.now(), by: 'system', what: 'Final bill created: Rs ' + fb.total + ' (estimate Rs ' + est.total + '). Waiting for admin approval.' }] };
        hist('Final bill Rs ' + fb.total + ' (paid Rs ' + paid + ', ' + (fb.total - paid >= 0 ? 'balance Rs ' + (fb.total - paid) : 'refund Rs ' + (paid - fb.total)) + ')');
      } else return done(400, { error: 'Unknown action.' });
      jobs.at = 0; c.saveBookings(list); return done(200, { ok: true });
    }
    return done(404, { error: 'Not found' });
  }
  airQuote.confirm = confirmOperator; airQuote.release = releaseHold;
  return { handle, quote: airQuote };
};
