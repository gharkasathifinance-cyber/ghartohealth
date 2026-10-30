// Ambulance booking: customer pays first, then the booking is created. Aadhaar photo is compulsory.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
// >>> APNE RATE YAHAN BADLO: total amount (in Rs) jo customer online deta hai. Yeh sirf example amounts hain.
const DEFAULT_ADVANCE = { charter: 50000, airline: 10000, heli: 25000, van: 1000 }; // sirf pehli baar ke liye; ab prices admin panel se badalte hain
const NAMES = { charter: 'Domestic Air Ambulance (Charter Aircraft, India)', airline: 'Domestic Commercial Airline Transfer', heli: 'Helicopter Ambulance', van: 'Road Ambulance (Van)' };
// >>> EXTRA CHARGES for each ambulance type (Rs). Change the amounts here. Use [] for none.
// The base service charge is still edited from the admin panel (price page) as before.
const EXTRAS = {
  charter: [['Ground ambulance (both ends)', 10000], ['Airport landing, parking and handling', 20000], ['Medical team (doctor + paramedic)', 40000], ['Oxygen and ICU equipment', 15000]],
  airline: [['Ground ambulance (both ends)', 5000], ['Medical escort (doctor or paramedic)', 15000], ['Oxygen support', 3000]],
  heli: [['Helipad landing and parking', 10000], ['Medical team (doctor + paramedic)', 20000], ['Ground ambulance (both ends)', 5000]],
  van: []
};
const AIR_ADV_FIXED = 5000;   // >>> Airline transfer: FIXED booking amount (Rs) the client pays at booking. Final price is set by admin after airline approval (admin-airline.html); this amount is deducted from it.
const AIR_PROC_FEE = 2000; // >>> Airline transfer: processing fee (Rs) kept when the CUSTOMER cancels. If the airline refuses, everything is refunded.
// >>> % of the TOTAL AMOUNT PAID that is returned if the customer cancels at this stage, before the processing fee is cut (keep the refund table on pay-balance.html and your Terms the same)
const AIR_REFUND = { received: 100, docs_ok: 100, airline_pending: 100, approved: 100, ticketed: 50, pickup: 50 };
const airRefund = (pay, a) => { const paid = (Number(pay.amount) || 0) + ((a.balance && a.balance.status === 'paid') ? (Number(a.balance.amount) || 0) : 0); return Math.max(0, Math.round(paid * (AIR_REFUND[a.stage] || 0) / 100) - AIR_PROC_FEE); };
const FEE_PCT = 5;   // Ghar to Health platform and booking fee (% of service total)
const GST_PCT = 18;  // GST charged ONLY on the platform fee. Patient transport itself is GST exempt (confirm with your CA).
const SVC = { lat: 21.2514, lng: 81.6296, km: 35 };   // road ambulance service area (Raipur)
const svcFar = v => { if (!v) return false; const r = x => x * Math.PI / 180, dl = r(v.lat - SVC.lat), dg = r(v.lng - SVC.lng), x = Math.sin(dl / 2) ** 2 + Math.cos(r(SVC.lat)) * Math.cos(r(v.lat)) * Math.sin(dg / 2) ** 2; return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)) > SVC.km; };
const SVC_MSG = 'Ghar to Health currently provides road ambulance service within Raipur only. We will be expanding to other cities very soon.';
const ynv = v => v === 'yes' ? 'yes' : v === 'no' ? 'no' : '';
// Ground ambulance is charged only for the ends the client asked for (both ends = full amount, one end = half). Only when both answers are given.
const adjGround = (list, ctx) => {
  if (!ctx || !ctx.groundPickup || !ctx.groundDrop) return list;
  const n = (ctx.groundPickup === 'yes' ? 1 : 0) + (ctx.groundDrop === 'yes' ? 1 : 0), out = [];
  for (const e of list) {
    if (!/ground\s*ambulance/i.test(e.label)) { out.push(e); continue; }
    if (n === 2) out.push(e);
    else if (n === 1) out.push({ label: e.label.replace(/\s*\(.*?\)\s*/g, ' ').trim() + ' (' + (ctx.groundPickup === 'yes' ? 'pickup end' : 'drop end') + ')', amount: Math.round(e.amount / 2) });
  }
  return out;
};
const ll = v => (v && Number.isFinite(+v.lat) && Number.isFinite(+v.lng) && Math.abs(+v.lat) <= 90 && Math.abs(+v.lng) <= 180) ? { lat: +(+v.lat).toFixed(6), lng: +(+v.lng).toFixed(6) } : null;
const mp = q => q ? 'https://www.google.com/maps/search/?api=1&query=' + q.lat + ',' + q.lng : '';
const SLOTS = ['Morning (9-12)', 'Afternoon (12-4)', 'Evening (4-8)'];
const AIRLINE_MIN_DAYS = 5;   // minimum days from today for a commercial airline transfer (keep the same as MINDAYS in ambulance.html)
const DOC_KEYS = ['fit', 'rep', 'bed', 'att', 'medif', 'rx', 'auth'];   // uploaded documents of an air booking (see the list inside /api/ambulance/start)
// Admin checklist for every airline booking (tick each one after checking it)
const CHECK_KEYS = ['medif', 'doctorSigned', 'fitness', 'reports', 'patientId', 'attendantId', 'hospitalLetter', 'consent', 'authorization', 'airlineApproval', 'advanceReceived', 'ticketCopy'];
module.exports = function (c) {
  const KEY = process.env.RAZORPAY_KEY_ID || '', SEC = process.env.RAZORPAY_KEY_SECRET || '', LIVE = !!(KEY && SEC);
  const D = path.join(__dirname, 'data'), PEND = path.join(D, 'ambulance-pending.json'), DOCS = path.join(D, 'customer-docs');
  const rd = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; } };
  const wr = (f, l) => { fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(f, JSON.stringify(l, null, 2)); };
  const PRICE_FILE = path.join(D, 'ambulance-prices.json');
  const getAdv = () => { const s = rd(PRICE_FILE), o = { ...DEFAULT_ADVANCE }; if (s && !Array.isArray(s)) for (const k of Object.keys(o)) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 1) o[k] = Math.round(Number(s[k])); return o; };
  // Charges are now kept in data/ambulance-charges.json and edited from admin-charges.html (no code edit, no restart).
  const CHG_FILE = path.join(D, 'ambulance-charges.json');
  const defCfg = () => ({ airAdvance: AIR_ADV_FIXED, feePct: FEE_PCT, gstPct: GST_PCT, extras: Object.fromEntries(Object.keys(NAMES).map(k => [k, (EXTRAS[k] || []).map(e => ({ label: e[0], amount: e[1] }))])) });
  const getCfg = () => {
    const s = rd(CHG_FILE), d = defCfg(); if (!s || Array.isArray(s)) return d;
    const num = (v, lo, hi, f) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi) ? Number(v) : f;
    d.airAdvance = Math.round(num(s.airAdvance, 1, 5000000, AIR_ADV_FIXED)); d.feePct = num(s.feePct, 0, 50, d.feePct); d.gstPct = num(s.gstPct, 0, 40, d.gstPct);
    if (s.extras) for (const k of Object.keys(d.extras)) if (Array.isArray(s.extras[k])) d.extras[k] = s.extras[k].map(e => ({ label: String(e.label || '').slice(0, 60), amount: Math.round(Number(e.amount) || 0) })).filter(e => e.label && e.amount > 0);
    d.updatedAt = s.updatedAt || ''; return d;
  };
  const airAdvance = total => Math.min(Number(total) || getCfg().airAdvance, getCfg().airAdvance);   // booking amount for airline transfer, set in admin-charges.html
  // ---------- invoice in Admin > Invoices (folder Ambulance) for every paid ambulance booking ----------
  function invoiceFor(b) {
    if (!c.invoices || !b || !b.payment) return null;
    const pay = b.payment, q = pay.breakdown || {}, air = b.ambType === 'airline', amt = Number(pay.amount) || 0;
    if (!(amt > 0)) return null;
    const items = (!air && Array.isArray(q.items) && q.items.length) ? q.items : [{ label: air ? 'Booking amount (advance, adjusted in the final bill)' : (b.item || 'Ambulance service'), amount: amt }];
    const charges = air ? [] : [{ label: 'Platform fee (' + q.feePct + '%)', amount: q.fee }, { label: 'GST (' + q.gstPct + '%) on fee', amount: q.gst }].filter(z => Number(z.amount) > 0);
    return c.invoices.create({ ...b, items: items.map(i => ({ name: i.label, price: Number(i.amount) || 0, qty: 1 })), subtotal: air ? amt : (q.serviceTotal != null ? q.serviceTotal : items.reduce((s, i) => s + (Number(i.amount) || 0), 0)), charges, total: amt },
      { amount: amt, at: pay.at || b.createdAt, payment: pay.mode === 'razorpay' ? 'Online (Razorpay)' : 'Demo (no real money)', status: pay.status === 'paid' ? 'Paid' : 'Demo' });
  }
  // older paid ambulance bookings that never got an invoice (safe to repeat: one invoice per booking)
  setTimeout(() => {
    try {
      let n = 0;
      for (const b of c.readBookings()) {
        if (!(b.type === 'medical' && b.service === 'Ambulance' && b.status !== 'cancelled' && b.payment)) continue;
        try { if (invoiceFor(b)) n++; } catch (e) { console.log('Ambulance invoice backfill failed for', b.id, e.message); }
      }
      if (n) console.log('Ambulance invoices checked:', n);
    } catch (e) { console.log('Ambulance invoice backfill:', e.message); }
  }, 2500).unref();
  // ---------- ROAD AMBULANCE rates (admin-charges.html > Road Ambulance). Stored in data/ambulance-road.json ----------
  const ROAD_FILE = path.join(D, 'ambulance-road.json');
  const ROAD_DEF = { types: { bls: { base: 1000, perKm: 15 }, als: { base: 2500, perKm: 25 } }, baseKm: 5, roadFactor: 1.3,
    addons: { oxygen: { amount: 300 }, paramedic: { amount: 500 }, doctor: { amount: 1500 } }, waitPerHour: 200, nightPct: 20, nightFrom: 22, nightTo: 6, payoutPct: 80 };
  const roadSaved = () => { const s = rd(ROAD_FILE); return s && !Array.isArray(s) && s.types ? s : null; };
  const getRoad = () => {
    const s = roadSaved() || {}, d = JSON.parse(JSON.stringify(ROAD_DEF)), n = (v, f) => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0) ? Number(v) : f;
    for (const t of ['bls', 'als']) { const x = (s.types || {})[t] || {}; d.types[t].base = n(x.base, d.types[t].base); d.types[t].perKm = n(x.perKm, d.types[t].perKm); }
    for (const a of ['oxygen', 'paramedic', 'doctor']) d.addons[a].amount = n(((s.addons || {})[a] || {}).amount, d.addons[a].amount);
    for (const k of ['baseKm', 'roadFactor', 'waitPerHour', 'nightPct', 'nightFrom', 'nightTo', 'payoutPct']) d[k] = n(s[k], d[k]);
    d.updatedAt = s.updatedAt || ''; return d;
  };
  const kmBetween = (a, b) => { const r = x => x * Math.PI / 180, dl = r(b.lat - a.lat), dg = r(b.lng - a.lng), x = Math.sin(dl / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dg / 2) ** 2; return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); };
  // Road van price: base + extra km + add-ons (+ night). The client sees the extra km merged into the base (one line).
  const roadItems = ctx => {
    // The booking page sends ctx.road = { type, oxygen, paramedic, doctor, waitHours }. An extra is charged ONLY when it is exactly true.
    const rq = (ctx.road && typeof ctx.road === 'object') ? ctx.road : {}, old = Array.isArray(ctx.addons) ? ctx.addons : [];
    const R = getRoad(), t = (rq.type || ctx.vanType) === 'als' ? 'als' : 'bls', km = Math.round(kmBetween(ctx.pickupLL, ctx.dropLL) * R.roadFactor * 10) / 10;
    const base = Math.round(R.types[t].base + Math.max(0, km - R.baseKm) * R.types[t].perKm), items = [{ label: (t === 'als' ? 'ICU / ALS' : 'Basic (BLS)') + ' road ambulance (' + km + ' km)', amount: base }];
    const h = new Date(Date.now() + 19800000).getUTCHours(), night = R.nightFrom > R.nightTo ? (h >= R.nightFrom || h < R.nightTo) : (h >= R.nightFrom && h < R.nightTo);
    if (night && R.nightPct > 0) items.push({ label: 'Night charge (' + R.nightPct + '%)', amount: Math.round(base * R.nightPct / 100) });
    const wh = Math.min(4, Math.max(0, Math.floor(Number(rq.waitHours) || 0)));
    if (wh > 0 && R.waitPerHour > 0) items.push({ label: 'Waiting at hospital (' + wh + ' hour' + (wh > 1 ? 's' : '') + ')', amount: Math.round(wh * R.waitPerHour) });
    const NM = [['oxygen', 'Oxygen Cylinder'], ['doctor', 'Doctor with patient'], ['paramedic', 'Paramedic with patient']];
    for (const [a, label] of NM) if ((rq[a] === true || old.includes(a)) && R.addons[a].amount > 0) items.push({ label, amount: Math.round(R.addons[a].amount) });
    return items;
  };
  let airQuoteFn = null;
  const quote = (o, adv, ctx) => {
    if (ctx && (o === 'charter' || o === 'heli') && !airQuoteFn) console.log('[air-quote] air-tracking.js is not connected. Replace server.js and air-tracking.js with the new files and restart the server.');
    if (ctx && (o === 'charter' || o === 'heli')) return (airQuoteFn && airQuoteFn(o, ctx.pickupLL, ctx.dropLL, { hold: ctx.hold, groundPickup: ctx.groundPickup, groundDrop: ctx.groundDrop })) || { error: 'Price for this service is not available right now. Please call us to book.' }; // aircraft price = hourly rate x hours only (no fixed base charge)
    const cfg = getCfg(), roadOn = o === 'van' && ctx && ctx.pickupLL && ctx.dropLL && roadSaved();   // road rates are used only after the admin has saved them once
    // Road van: oxygen / paramedic / doctor are charged ONLY from the client's checkboxes (roadItems). A saved "fixed charge" with such a name would be added to every booking and double the price, so it is skipped here.
    const fixedList = (cfg.extras[o] || []).filter(e => !(roadOn && /oxygen|paramedic|doctor/i.test(e.label)));
    const items = (roadOn ? roadItems(ctx) : [{ label: 'Base service charge', amount: adv[o] }]).concat(adjGround(fixedList, ctx));
    const serviceTotal = items.reduce((s, i) => s + i.amount, 0), fee = Math.round(serviceTotal * cfg.feePct / 100), gst = Math.round(fee * cfg.gstPct / 100);
    return { items, serviceTotal, feePct: cfg.feePct, fee, gstPct: cfg.gstPct, gst, total: serviceTotal + fee + gst };
  };
  console.log(LIVE ? 'Ambulance payments: Razorpay keys found (LIVE)' : 'Ambulance payments: DEMO MODE - no real money is taken. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET before going live.');
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  function saveDoc(id, u, pdfOk) { // Aadhaar photo and other documents go to data/customer-docs (NOT public). pdfOk = also accept a PDF (MEDIF, letters)
    const m = /^data:(?:image\/(jpeg|png)|(application\/pdf));base64,([A-Za-z0-9+/=]+)$/.exec(String(u || ''));
    if (!m || (m[2] && !pdfOk)) return null;
    const buf = Buffer.from(m[3], 'base64'), kind = m[2] ? 'pdf' : m[1];
    if (buf.length < 3000 || buf.length > 2.5e6 || !(kind === 'pdf' ? buf.slice(0, 4).toString() === '%PDF' : kind === 'jpeg' ? buf[0] === 0xFF && buf[1] === 0xD8 : buf[0] === 0x89 && buf[1] === 0x50)) return null;
    const ext = kind === 'pdf' ? 'pdf' : kind === 'jpeg' ? 'jpg' : 'png'; fs.mkdirSync(DOCS, { recursive: true });
    fs.writeFileSync(path.join(DOCS, id + '.' + ext), buf); return ext;
  }
  async function handle(req, res, url) {
    const p = url.pathname, ADVANCE = getAdv();
    if (!p.startsWith('/api/ambulance') && p !== '/api/admin/booking-doc') return false;
    const done = (s, o) => { c.send(res, s, o); return true; }, POST = req.method === 'POST';
    const body = async () => { try { return await c.readBody(req, 24e6); } catch { return {}; } };   // up to 7 document types x 5 files, each max 2.5 MB
    if (p === '/api/ambulance/admin-prices') {
      if (req.headers['x-admin-key'] !== c.ADMIN_KEY) return done(401, { error: 'Wrong admin key' });
      if (req.method === 'GET') return done(200, { items: Object.keys(ADVANCE).map(id => ({ id, name: NAMES[id], price: ADVANCE[id] })) });
      if (req.method === 'PUT') {
        const b = await body(), pr = (b && b.prices) || {}, out = { ...ADVANCE };
        for (const k of Object.keys(out)) if (k in pr) {
          const n = Math.round(Number(pr[k]));
          if (!(n >= 1 && n <= 5000000)) return done(400, { error: NAMES[k] + ': price 1 se 50,00,000 ke beech hona chahiye.' });
          out[k] = n;
        }
        fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(PRICE_FILE, JSON.stringify(out, null, 2));
        return done(200, { ok: true });
      }
    }
    if (p === '/api/ambulance/admin-charges') {
      if (req.headers['x-admin-key'] !== c.ADMIN_KEY) return done(401, { error: 'Wrong admin key' });
      if (req.method === 'GET') return done(200, { ...getCfg(), names: NAMES });
      if (req.method === 'PUT') {
        const b = await body(), o = { feePct: Number(b.feePct), gstPct: Number(b.gstPct), extras: {}, airAdvance: b.airAdvance == null ? getCfg().airAdvance : Math.round(Number(b.airAdvance)) };
        if (!(o.airAdvance >= 1 && o.airAdvance <= 5000000)) return done(400, { error: 'Airline booking amount must be 1 to 50,00,000.' });
        if (!(o.feePct >= 0 && o.feePct <= 50)) return done(400, { error: 'Platform fee must be between 0 and 50 %.' });
        if (!(o.gstPct >= 0 && o.gstPct <= 40)) return done(400, { error: 'GST must be between 0 and 40 %.' });
        for (const k of Object.keys(NAMES)) {
          const l = Array.isArray(b.extras && b.extras[k]) ? b.extras[k] : []; o.extras[k] = [];
          if (l.length > 12) return done(400, { error: NAMES[k] + ': maximum 12 extra charges.' });
          for (const e of l) {
            const label = c.clean(e.label, 60), amt = Math.round(Number(e.amount)); if (!label) continue;
            if (!(amt >= 1 && amt <= 5000000)) return done(400, { error: NAMES[k] + ' - ' + label + ': amount must be 1 to 50,00,000.' });
            o.extras[k].push({ label, amount: amt });
          }
        }
        o.updatedAt = new Date().toISOString(); fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(CHG_FILE, JSON.stringify(o, null, 2));
        return done(200, { ok: true });
      }
    }
    if (p === '/api/ambulance/admin-road') {   // admin-charges.html > Road Ambulance rates (BLS / ALS, extra km, add-ons, night, operator payout)
      if (req.headers['x-admin-key'] !== c.ADMIN_KEY) return done(401, { error: 'Wrong admin key' });
      if (req.method === 'GET') return done(200, getRoad());
      if (req.method === 'PUT') {
        const b = await body(), num = (v, lo, hi) => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi) ? Number(v) : null;
        const T = (b && b.types) || {}, A = (b && b.addons) || {}, o = { types: { bls: {}, als: {} }, addons: { oxygen: {}, paramedic: {}, doctor: {} } };
        for (const t of ['bls', 'als']) {
          o.types[t].base = num((T[t] || {}).base, 0, 5000000); o.types[t].perKm = num((T[t] || {}).perKm, 0, 100000);
          if (o.types[t].base === null || o.types[t].perKm === null) return done(400, { error: (t === 'bls' ? 'Basic (BLS)' : 'ICU / ALS') + ': base charge and extra km rate must be numbers (0 or more).' });
        }
        for (const a of ['oxygen', 'paramedic', 'doctor']) { o.addons[a].amount = num((A[a] || {}).amount, 0, 5000000); if (o.addons[a].amount === null) return done(400, { error: 'Add-on ' + a + ': enter a valid amount.' }); }
        const L = { baseKm: ['Km in base', 0, 1000], roadFactor: ['Road factor', 1, 5], waitPerHour: ['Waiting charge', 0, 1000000], nightPct: ['Night extra %', 0, 200], nightFrom: ['Night from (hr)', 0, 23], nightTo: ['Night until (hr)', 0, 23], payoutPct: ['Operator gets %', 0, 100] };
        for (const k of Object.keys(L)) { o[k] = num(b[k], L[k][1], L[k][2]); if (o[k] === null) return done(400, { error: L[k][0] + ' must be a number from ' + L[k][1] + ' to ' + L[k][2] + '.' }); }
        o.updatedAt = new Date().toISOString(); fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(ROAD_FILE, JSON.stringify(o, null, 2));
        return done(200, { ok: true });
      }
    }
    if (p === '/api/ambulance/kind' && POST) {   // Ambulance Tracking tab: what type is this booking (booking ID + mobile)
      const b = await body(), ph = c.clean(b.phone, 15).replace(/\D/g, '').slice(-10);
      const bk = c.readBookings().find(y => y.id === c.clean(b.id, 30).toUpperCase() && String(y.phone).slice(-10) === ph && y.service === 'Ambulance');
      if (!bk) return done(404, { error: 'No ambulance booking found. Check the ID and mobile number.' });
      const nm = String(bk.item || ''), guess = /heli/i.test(nm) ? 'heli' : /airline|commercial/i.test(nm) ? 'airline' : /charter/i.test(nm) ? 'charter' : /van|road/i.test(nm) ? 'van' : '';   // old bookings have no ambType
      return done(200, { id: bk.id, kind: bk.ambType || guess, cancelled: bk.status === 'cancelled' });
    }
    if (p === '/api/ambulance/air-update' && POST) { // admin: move a commercial-airline transfer through its stages
      if (req.headers['x-admin-key'] !== c.ADMIN_KEY) return done(401, { error: 'Wrong admin key' });
      const b = await body(), list = c.readBookings(), bk = list.find(y => y.id === c.clean(b.id, 30));
      const ST = ['received', 'docs_ok', 'airline_pending', 'approved', 'ticketed', 'pickup', 'flown', 'landed', 'handed', 'refused'];
      if (!bk || !bk.air) return done(404, { error: 'Booking not found' });
      if (!ST.includes(b.stage)) return done(400, { error: 'Invalid stage' });
      if (b.stage === 'approved' && !(bk.air && bk.air.final)) return done(400, { error: 'Pehle admin-airline.html mein final price daalo aur "Approve and send to client" dabao.' });
      if (b.stage === 'handed' && !c.clean(b.handoverBy, 80)) return done(400, { error: 'Handover: hospital mein mareez ko receive karne wale ka naam daalo.' });
      if (['ticketed', 'pickup', 'flown', 'landed', 'handed'].includes(b.stage) && bk.ambType === 'airline' && !(bk.air.balance && bk.air.balance.status === 'paid')) return done(400, { error: 'Pehle customer ka baaki payment aana chahiye.' });
      if (b.stage === 'refused') { const pay = bk.payment, pb = bk.air.balance && bk.air.balance.status === 'paid'; bk.status = 'cancelled'; bk.air.refundDue = pb ? (pay.total || pay.amount) : pay.amount; }
      Object.assign(bk.air, { stage: b.stage, airline: c.clean(b.airline, 40), flightNo: c.clean(b.flightNo, 12), pnr: c.clean(b.pnr, 12), escort: c.clean(b.escort, 80), dropAmb: c.clean(b.dropAmb, 80), handoverBy: c.clean(b.handoverBy, 80), depTime: c.clean(b.depTime, 40), flightDate: /^\d{4}-\d{2}-\d{2}$/.test(String(b.flightDate || '')) ? b.flightDate : (bk.air.flightDate || '') });
      (bk.history = bk.history || []).push({ at: new Date().toISOString(), event: 'Flight transfer stage: ' + b.stage });
      if (b.stage === 'handed') bk.status = 'completed';
      c.saveBookings(list); return done(200, { ok: true });
    }
    // ---- admin: commercial airline bookings. Set the FINAL price after airline approval; the client then gets the pop-up
    const isAirline = bk => bk && bk.air && (bk.ambType === 'airline' || bk.option === 'airline' || /airline|commercial/i.test(String(bk.item || '')));
    if (p === '/api/ambulance/air-list' && req.method === 'GET') {
      if (req.headers['x-admin-key'] !== c.ADMIN_KEY) return done(401, { error: 'Wrong admin key' });
      const items = c.readBookings().filter(isAirline).reverse().map(bk => { const a = bk.air, pay = bk.payment || {}, est = (pay.breakdown && pay.breakdown.items) || [];
        return { id: bk.id, name: bk.name, phone: bk.phone, createdAt: bk.createdAt, date: bk.date, slot: bk.slot, pickup: a.airportPickup || bk.pickup, drop: a.airportDrop || bk.drop, stage: a.stage, cancelled: bk.status === 'cancelled',
          paidAdvance: Number(pay.amount) || 0, estTotal: Number(pay.estTotal || (a.final ? 0 : pay.total)) || 0, estItems: est.map(i => ({ label: i.label, amount: i.amount })), final: a.final || null, balancePaid: !!(a.balance && a.balance.status === 'paid') }; });
      return done(200, { items, feePct: FEE_PCT, gstPct: GST_PCT, advance: getCfg().airAdvance });
    }
    if (p === '/api/ambulance/air-approve' && POST) {
      if (req.headers['x-admin-key'] !== c.ADMIN_KEY) return done(401, { error: 'Wrong admin key' });
      const b = await body(), list = c.readBookings(), bk = list.find(y => y.id === c.clean(b.id, 30));
      if (!isAirline(bk)) return done(404, { error: 'Airline booking not found' });
      if (bk.status === 'cancelled' || ['ticketed', 'pickup', 'flown', 'landed', 'handed', 'refused'].includes(bk.air.stage)) return done(400, { error: 'This booking can no longer be approved or re-priced.' });
      if (bk.air.balance && bk.air.balance.status === 'paid') return done(400, { error: 'Client has already paid the balance. Price cannot be changed.' });
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 15).map(i => ({ label: c.clean(i && i.label, 60), amount: Math.round(Number(i && i.amount)) })).filter(i => i.label && Number.isFinite(i.amount) && i.amount > 0 && i.amount <= 5000000);
      if (!items.length) return done(400, { error: 'Add at least one price item (name and amount).' });
      const lines = t => String(t || '').split(/\r?\n/).map(x => c.clean(x, 120)).filter(Boolean).slice(0, 15);
      const serviceTotal = items.reduce((t, i) => t + i.amount, 0), fee = Math.round(serviceTotal * FEE_PCT / 100), gst = Math.round(fee * GST_PCT / 100), total = serviceTotal + fee + gst, pay = bk.payment;
      if (total <= (Number(pay.amount) || 0)) return done(400, { error: 'Final total must be more than the booking amount already paid (Rs ' + pay.amount + ').' });
      const now = new Date().toISOString(), first = !bk.air.final;
      bk.air.final = { items, serviceTotal, feePct: FEE_PCT, fee, gstPct: GST_PCT, gst, total, included: lines(b.included), notIncluded: lines(b.notIncluded), note: c.clean(b.note, 300), at: now };
      if (pay.estTotal == null) pay.estTotal = pay.total;
      pay.total = total;
      bk.history = bk.history || [];
      if (bk.air.stage !== 'approved') { bk.air.stage = 'approved'; bk.history.push({ at: now, event: 'Flight transfer stage: approved' }); }
      bk.history.push({ at: now, event: (first ? 'Final price sent to client' : 'Final price updated') + ': Rs ' + total + ' (booking amount Rs ' + pay.amount + ' adjusted, balance Rs ' + (total - pay.amount) + ')' });
      c.saveBookings(list); return done(200, { ok: true, total, balance: total - pay.amount });
    }
    // ---- treating doctor signs online through a private link (no login). Admin makes the link; doctor opens it on any phone.
    const DOC_DAYS = 7, DOC_ERR = 'This link is not valid or has expired. Please ask Ghar to Health for a new link.';
    const docOk = (bk, t) => !!(bk && bk.air && bk.air.docSign && bk.air.docSign.status === 'sent' && typeof t === 'string' && t.length === 32 && same(t, bk.air.docSign.token) && Date.now() - new Date(bk.air.docSign.createdAt).getTime() < DOC_DAYS * 864e5);
    if (p === '/api/ambulance/doctor-link' && POST) {
      if (req.headers['x-admin-key'] !== c.ADMIN_KEY) return done(401, { error: 'Wrong admin key' });
      const b = await body(), list = c.readBookings(), bk = list.find(y => y.id === c.clean(b.id, 30));
      if (!bk || !bk.air) return done(404, { error: 'Booking not found' });
      if (bk.air.doctor) return done(400, { error: 'Doctor has already signed this booking.' });
      bk.air.docSign = { token: crypto.randomBytes(16).toString('hex'), createdAt: new Date().toISOString(), status: 'sent' };
      (bk.history = bk.history || []).push({ at: new Date().toISOString(), event: 'Doctor sign link created' });
      c.saveBookings(list); return done(200, { ok: true, days: DOC_DAYS });
    }
    if (p === '/api/ambulance/doctor-info' && req.method === 'GET') {
      const bk = c.readBookings().find(y => y.id === c.clean(url.searchParams.get('id'), 30).toUpperCase());
      if (!docOk(bk, url.searchParams.get('t'))) return done(404, { error: DOC_ERR });
      const a = bk.air;
      return done(200, { id: bk.id, patient: bk.name, age: bk.age || '', weight: a.weight, dx: a.dx, mode: a.mode, oxygen: a.oxygen, infection: a.infection, infectionNote: a.infectionNote || '', date: bk.date, pickup: bk.pickup, drop: bk.drop, dropHospital: a.dropHospital,
        doctor: { name: a.docName || '', hospital: a.docHospital || '', regNo: a.docReg || '', phone: a.docPhone || '' } });
    }
    if (p === '/api/ambulance/doctor-submit' && POST) {
      const b = await body(), list = c.readBookings(), bk = list.find(y => y.id === c.clean(b.id, 30).toUpperCase());
      if (!docOk(bk, b.t)) return done(404, { error: DOC_ERR });
      const d = { name: c.clean(b.name, 80), regNo: c.clean(b.regNo, 40), hospital: c.clean(b.hospital, 120), phone: c.clean(b.phone, 15).replace(/\D/g, '').slice(-10), remarks: c.clean(b.remarks, 300) };
      if (d.name.length < 2 || d.regNo.length < 3) return done(400, { error: 'Please enter your name and medical registration number.' });
      if (b.declaration !== true) return done(400, { error: 'Please tick the declaration.' });
      const sg = String(b.signature || ''), sm = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(sg);
      if (!sm || sg.length > 200000 || Buffer.from(sm[1], 'base64')[0] !== 0x89) return done(400, { error: 'Please sign in the signature box.' });
      bk.air.doctor = { ...d, signature: sg, at: new Date().toISOString() };
      bk.air.docSign.status = 'signed';
      (bk.history = bk.history || []).push({ at: new Date().toISOString(), event: 'Treating doctor signed online (Dr ' + d.name + ')' });
      c.saveBookings(list); return done(200, { ok: true });
    }
    // ---- customer: airline transfer status, balance payment, cancel (needs booking ID + mobile)
    if (p.startsWith('/api/ambulance/air-') && p !== '/api/ambulance/air-update' && p !== '/api/ambulance/air-checklist' && POST) {
      const b = await body(), l = c.readBookings(), ph = c.clean(b.phone, 15).replace(/\D/g, '').slice(-10);
      const bk = l.find(y => y.id === c.clean(b.id, 30).toUpperCase() && String(y.phone).slice(-10) === ph && y.air && y.payment);
      if (!bk) return done(404, { error: 'No booking found. Check the ID and mobile number.' });
      const info = () => { const a = bk.air, pay = bk.payment, fin = a.final || null, total = pay.total || pay.amount, bal = total - pay.amount, paid = !!(a.balance && a.balance.status === 'paid'), live = bk.status !== 'cancelled';
        const times = { received: bk.createdAt }; (bk.history || []).forEach(h => { const m = /^Flight transfer stage: (\w+)/.exec(h.event || ''); if (m) times[m[1]] = h.at; });
        return { id: bk.id, stage: a.stage, cancelled: !live, times, airline: a.airline || '', flightNo: a.flightNo || '', escort: a.escort || '', depTime: a.depTime || '', dropAmb: a.dropAmb || '', handoverBy: a.handoverBy || '',
          pickup: bk.pickup || '', drop: bk.drop || '', airportPickup: a.airportPickup || '', airportDrop: a.airportDrop || '', date: bk.date || '', slot: bk.slot || '', pickupLL: bk.pickupLL || null, dropLL: bk.dropLL || null,
          total: fin ? total : null, fee: pay.amount, balance: fin ? bal : null, final: fin, paid, canPay: live && !paid && !!fin && bal > 0 && a.stage === 'approved',
          canCancel: live && ['received', 'docs_ok', 'airline_pending', 'approved', 'ticketed', 'pickup'].includes(a.stage), refund: live ? airRefund(pay, a) : (a.refundDue || 0), procFee: AIR_PROC_FEE, advance: getCfg().airAdvance, live: LIVE }; };
      const i = info(), hist = t => (bk.history = bk.history || []).push({ at: new Date().toISOString(), event: t });
      if (p === '/api/ambulance/air-status') return done(200, i);
      if (p === '/api/ambulance/air-cancel') {
        if (!i.canCancel) return done(400, { error: 'Online cancellation is not possible now. Please call us.' });
        bk.status = 'cancelled'; bk.air.refundDue = i.refund; bk.air.cancelledBy = 'customer'; hist('Cancelled by customer. Refund due Rs ' + i.refund); c.saveBookings(l); return done(200, { ok: true, refund: i.refund });
      }
      if (!i.canPay) return done(400, { error: 'Balance payment is not open for this booking.' });
      if (p === '/api/ambulance/air-pay-start') {
        if (!LIVE) return done(200, { demo: true, amount: i.balance });
        try {
          const r = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(KEY + ':' + SEC).toString('base64') }, body: JSON.stringify({ amount: i.balance * 100, currency: 'INR', receipt: bk.id + 'B' }) });
          const j = await r.json(); if (!r.ok) throw 0; bk.air.balance = { status: 'due', orderId: j.id }; c.saveBookings(l); return done(200, { amount: i.balance, orderId: j.id, keyId: KEY });
        } catch { return done(502, { error: 'Payment could not be started. Please try again.' }); }
      }
      if (p === '/api/ambulance/air-pay-confirm') {
        const pid = c.clean(b.razorpay_payment_id, 60);
        if (LIVE) { const sig = crypto.createHmac('sha256', SEC).update(((bk.air.balance || {}).orderId || '') + '|' + pid).digest('hex'); if (c.clean(b.razorpay_order_id, 60) !== (bk.air.balance || {}).orderId || !same(sig, String(b.razorpay_signature || ''))) return done(400, { error: 'Payment could not be verified.' }); }
        bk.air.balance = { status: 'paid', at: new Date().toISOString(), paymentId: LIVE ? pid : 'DEMO', amount: i.balance }; hist('Balance Rs ' + i.balance + (LIVE ? ' paid' : ' (DEMO)')); c.saveBookings(l); return done(200, { ok: true });
      }
    }
    if (p === '/api/ambulance/air-policy' && req.method === 'GET') return done(200, { advance: getCfg().airAdvance, procFee: AIR_PROC_FEE, refund: AIR_REFUND });   // used by pay-balance.html so the table always matches the real rules
    if (p === '/api/ambulance/options') return done(200, { live: LIVE, items: Object.keys(ADVANCE).map(id => ({ id, name: NAMES[id] })) }); // no prices here: the price is shown only after pickup and drop are entered
    if (p === '/api/ambulance/quote' && POST) { // total price is calculated on the server, only after pickup and drop are given
      const b = await body(), o = c.clean(b.option, 20), pu = c.clean(b.pickup, 160), dr = c.clean(b.drop, 160);
      if (!Object.keys(ADVANCE).includes(o)) return done(400, { error: 'Unknown ambulance type.' });
      if (pu.length < 2 || dr.length < 2) return done(400, { error: 'Please enter pickup and drop locations.' });
      if (o === 'van' && (svcFar(ll(b.pickupLL)) || svcFar(ll(b.dropLL)))) return done(400, { error: SVC_MSG });
      const q = quote(o, ADVANCE, { pickupLL: ll(b.pickupLL), dropLL: ll(b.dropLL), groundPickup: ynv(b.groundPickup), groundDrop: ynv(b.groundDrop), vanType: b.vanType, addons: b.addons, road: b.road });
      if (q.error) return done(400, { error: q.error });
      delete q._op;   // which operator is never shown to the client
      return done(200, { quote: q, total: q.total, payNow: o === 'airline' ? airAdvance(q.total) : q.total, advance: o === 'airline' ? AIR_ADV_FIXED : undefined, policy: o === 'airline' ? { procFee: AIR_PROC_FEE, refund: AIR_REFUND } : undefined });
    }
    if (p === '/api/ambulance/start' && POST) {
      const b = await body(), o = c.clean(b.option, 20), today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
      const m = { name: c.clean(b.name, 80), phone: c.clean(b.phone, 15).replace(/[\s-]/g, ''), age: c.clean(b.age, 3), address: c.clean(b.address, 250), date: c.clean(b.date, 10),
        slot: c.clean(b.slot, 30), pickup: c.clean(b.pickup, 160), drop: c.clean(b.drop, 160), note: c.clean(b.note, 200),
        pickupLL: ll(b.pickupLL), dropLL: ll(b.dropLL), addressLL: ll(b.addressLL) };
      if (!ADVANCE[o]) return done(400, { error: 'Please choose an ambulance type.' });
      // Charter aircraft and helicopter can be urgent: 'now' / 'today' use today's date (India time) and need no date or slot
      const urg = (o === 'charter' || o === 'heli') && b.air && ['now', 'today'].includes(b.air.urgency) ? b.air.urgency : 'planned';
      if (urg !== 'planned') { m.date = today; if (!SLOTS.includes(m.slot)) m.slot = SLOTS[0]; }
      if (m.name.length < 2) return done(400, { error: 'Please enter the patient name.' });
      if (!/^(\+91)?[6-9]\d{9}$/.test(m.phone)) return done(400, { error: 'Enter a valid 10-digit mobile number.' });
      if (m.address.length < 5) return done(400, { error: 'Please enter your address.' });
      if (m.pickup.length < 2 || m.drop.length < 2) return done(400, { error: 'Please enter pickup and drop locations.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date) || m.date < today) return done(400, { error: 'Please choose a valid date.' });
      if (!SLOTS.includes(m.slot)) return done(400, { error: 'Please choose a time.' });
      if (b.consent !== true) return done(400, { error: 'Please tick the consent box to continue.' });
      let air = null;
      if (o === 'airline' || o === 'charter' || o === 'heli') { // all air options need the medical details
        const minDate = new Date(Date.now() + 19800000 + AIRLINE_MIN_DAYS * 864e5).toISOString().slice(0, 10); // Air India wants the MEDIF at least 5 days before departure
        if (o === 'airline' && m.date < minDate) return done(400, { error: 'For a flight transfer please choose a travel date at least ' + AIRLINE_MIN_DAYS + ' days from today, because Air India needs the MEDIF and approval before the flight.' });
        if (!/^\d{1,3}$/.test(m.age) || +m.age > 120) return done(400, { error: 'Please enter the patient age.' });
        const t = b.air || {}, yn = v => v === 'yes' ? 'yes' : 'no';
        air = { weight: Math.round(+t.weight) || 0, dx: c.clean(t.dx, 200), mode: t.mode === 'sit' ? 'sit' : 'stretcher', oxygen: yn(t.oxygen), infection: yn(t.infection),
          attendant: c.clean(t.attendant, 80), attendantPhone: c.clean(t.attendantPhone, 15).replace(/\D/g, '').slice(-10), dropHospital: c.clean(t.dropHospital, 120) };
        if (!(air.weight > 0 && air.weight <= 250) || air.dx.length < 3 || air.attendant.length < 2 || air.attendantPhone.length !== 10 || air.dropHospital.length < 2) return done(400, { error: 'Please fill all flight transfer details.' });
        air.infectionNote = c.clean(t.infectionNote, 100); if (air.infection === 'yes' && air.infectionNote.length < 3) return done(400, { error: 'Please write which infectious disease the patient has.' });
        const sg = String(t.signature || ''), sm = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(sg); // client's drawn signature (small PNG, kept inside the booking)
        if (!sm || sg.length > 200000 || Buffer.from(sm[1], 'base64')[0] !== 0x89) return done(400, { error: 'Please sign in the signature box.' });
        air.signature = sg;
        Object.assign(air, { docName: c.clean(t.docName, 80), docHospital: c.clean(t.docHospital, 120), docReg: c.clean(t.docReg, 40), docPhone: c.clean(t.docPhone, 15).replace(/\D/g, '').slice(-10),
          emName: c.clean(t.emName, 80), emRel: c.clean(t.emRel, 40), emPhone: c.clean(t.emPhone, 15).replace(/\D/g, '').slice(-10) });
        if (air.docName.length < 2 || air.docPhone.length !== 10 || air.emName.length < 2 || air.emPhone.length !== 10) return done(400, { error: 'Please fill the treating doctor name, doctor phone and the emergency contact.' });
        if (air.docReg.length < 3) return done(400, { error: 'Please enter the treating doctor registration number (it is needed for the MEDIF).' });
        // extra details for the airline: gender, recent surgery, equipment, pregnancy, lift / stairs, ground ambulance type, flexible dates, who is booking
        const GT = ['basic', 'icu'], RQ = ['self', 'relative'];
        Object.assign(air, { gender: ['male', 'female', 'other'].includes(t.gender) ? t.gender : '', surgeryDate: /^\d{4}-\d{2}-\d{2}$/.test(String(t.surgeryDate || '')) ? t.surgeryDate : '', equipment: c.clean(t.equipment, 200),
          pregnant: t.gender === 'female' ? yn(t.pregnant) : 'no', conscious: yn(t.conscious), lift: ['lift', 'stairs', 'ground'].includes(t.lift) ? t.lift : '', groundType: GT.includes(t.groundType) ? t.groundType : 'basic',
          dateFrom: /^\d{4}-\d{2}-\d{2}$/.test(String(t.dateFrom || '')) ? t.dateFrom : '', dateTo: /^\d{4}-\d{2}-\d{2}$/.test(String(t.dateTo || '')) ? t.dateTo : '',
          requester: RQ.includes(t.requester) ? t.requester : 'self', requesterName: c.clean(t.requesterName, 80), requesterRel: c.clean(t.requesterRel, 40), meds: c.clean(t.meds, 300),
          attendants: (Array.isArray(t.attendants) ? t.attendants : []).slice(0, 3).map(a => ({ name: c.clean(a && a.name, 80), age: c.clean(a && a.age, 3), rel: c.clean(a && a.rel, 40), phone: c.clean(a && a.phone, 15).replace(/\D/g, '').slice(-10), idType: a && a.idType === 'passport' ? 'Passport' : 'Aadhaar' })).filter(a => a.name) });
        // gender is optional on the server so the older booking forms (which do not ask it) keep working
        if (air.attendants.length && air.attendants.some(a => !(+a.age >= 18))) return done(400, { error: 'Every attendant must be an adult (18 years or more). Please enter the age of each attendant.' });
        if (air.requester === 'relative' && (air.requesterName.length < 2 || air.requesterRel.length < 2)) return done(400, { error: 'Please enter the name of the person booking and the relation with the patient.' });
        if (air.surgeryDate && air.surgeryDate > today) return done(400, { error: 'Surgery date cannot be in the future.' });
        const SUP = ['Ventilator', 'ICU setup', 'Cardiac monitor', 'Incubator (child)'];
        Object.assign(air, { urgency: urg, cond: t.cond === 'critical' ? 'critical' : t.cond === 'stable' ? 'stable' : '', support: (Array.isArray(t.support) ? t.support : []).map(x => c.clean(x, 30)).filter(x => SUP.includes(x)).slice(0, 4),
          pickupHospital: c.clean(t.pickupHospital, 120), attCount: Math.min(3, Math.max(1, Math.round(+t.attCount) || 1)),
          attWeights: (Array.isArray(t.attWeights) ? t.attWeights : []).map(w => Math.round(+w)).filter(w => w > 0 && w <= 200).slice(0, 3) });
        if (!air.cond) return done(400, { error: 'Please choose the patient condition (stable or critical).' });
        if (air.pickupHospital.length < 2) return done(400, { error: 'Please enter the pickup hospital (or write Home).' });
        if (air.attWeights.length !== air.attCount) return done(400, { error: 'Please enter the weight of each attendant.' });
        if (o === 'airline' || o === 'charter' || o === 'heli') { // aircraft: airports and ground ambulance at both ends
          Object.assign(air, { airportPickup: c.clean(t.airportPickup, 80), airportDrop: c.clean(t.airportDrop, 80), groundPickup: yn(t.groundPickup), groundDrop: yn(t.groundDrop) });
          if (air.airportPickup.length < 2 || air.airportDrop.length < 2) return done(400, { error: 'Please enter the airport / airstrip for pickup and drop.' });
        }
        if (o === 'heli') { // helicopter: landing sites and distance
          const LS = ['helipad', 'ground', 'unsure'];
          Object.assign(air, { landPickup: LS.includes(t.landPickup) ? t.landPickup : '', landDrop: LS.includes(t.landDrop) ? t.landDrop : '', landPickupKm: c.clean(t.landPickupKm, 6), landDropKm: c.clean(t.landDropKm, 6), distanceKm: Math.round(+t.distanceKm) || 0 });
          if (!air.landPickup || !air.landDrop) return done(400, { error: 'Please choose the landing place at pickup and at drop.' });
          if (!(air.distanceKm > 0 && air.distanceKm <= 1500)) return done(400, { error: 'Please enter the approximate total distance in km.' });
        }
      }
      const id = 'AMB' + Date.now().toString(36).toUpperCase(), ext = saveDoc(id, b.idProof);
      if (!ext) return done(400, { error: 'ID (Aadhaar ya Passport) ki clear photo zaroori hai.' });
      const idType = b.idType === 'passport' ? 'Passport' : 'Aadhaar';
      if (air) {
        air.docs = {}; const dd = b.air.docs || {};
        // fit = fitness-to-fly letter, rep = medical reports + discharge summary, bed = drop hospital acceptance letter, att = attendant Aadhaar,
        // medif = MEDIF form, rx = prescription list, auth = authorization letter (needed when a relative is booking)
        for (const k of DOC_KEYS) {
          const list = (Array.isArray(dd[k]) ? dd[k] : [dd[k]]).filter(Boolean).slice(0, 5); // 1 to 5 photos per document
          if (!list.length) {
            if (k === 'auth' && air.requester === 'relative') return done(400, { error: 'Authorization letter from the patient (or family) is compulsory when a relative is booking.' });
            if (k === 'medif' && o === 'airline') return done(400, { error: 'Please upload the filled and signed Air India MEDIF. You can download it from the booking form.' });   // compulsory for commercial airline transfer
            if (['bed', 'medif', 'rx', 'auth'].includes(k)) continue;
            return done(400, { error: k === 'att' ? 'Please upload the ID photo of each attendant.' : 'Fitness certificate and medical reports are compulsory.' });
          }
          if (k === 'att' && list.length < air.attCount) return done(400, { error: 'Please upload the ID photo of each attendant (' + air.attCount + ').' });
          const exts = [];
          for (let n = 0; n < list.length; n++) { // photo 1 keeps the old file name (id-k.ext), photo 2+ get id-k-2.ext ...
            const e2 = saveDoc(id + '-' + k + (n ? '-' + (n + 1) : ''), list[n], true); if (!e2) return done(400, { error: 'Document photo ' + (n + 1) + ' is not clear or too large. Please upload again.' }); exts.push(e2);
          }
          air.docs[k] = exts[0]; air.docs[k + 'List'] = exts;
        }
      }
      if (o === 'van' && (svcFar(ll(b.pickupLL)) || svcFar(ll(b.dropLL)))) return done(400, { error: SVC_MSG });
      const q = quote(o, ADVANCE, { pickupLL: ll(b.pickupLL), dropLL: ll(b.dropLL), hold: { ref: id, key: m.phone }, groundPickup: ynv(air && air.groundPickup), groundDrop: ynv(air && air.groundDrop), vanType: b.vanType, addons: b.addons, road: b.road });
      if (q.error) return done(400, { error: q.error });
      const opId = q._op || ''; delete q._op;
      if (opId && Number(b.expectTotal) > 0 && Number(b.expectTotal) !== q.total) { // another operator became the first free one after the client saw the price
        airQuoteFn.release(id);
        return done(409, { error: 'The price has changed to Rs ' + q.total.toLocaleString('en-IN') + ' because a different aircraft is now the first one available. Please check the new price and press Book again.', requote: true });
      }
      const x = { id, option: o, operatorId: opId, amount: o === 'airline' ? airAdvance(q.total) : q.total, total: q.total, quote: q, ...m, air, idExt: ext, idType, createdAt: new Date().toISOString(), orderId: '' };
      if (LIVE) {
        try {
          const r = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(KEY + ':' + SEC).toString('base64') },
            body: JSON.stringify({ amount: x.amount * 100, currency: 'INR', receipt: id }) });
          const j = await r.json(); if (!r.ok) throw 0; x.orderId = j.id;
        } catch { if (airQuoteFn && airQuoteFn.release) airQuoteFn.release(id); return done(502, { error: 'Payment could not be started. Please try again.' }); }
      }
      const l = rd(PEND).filter(y => Date.now() - Date.parse(y.createdAt) < 2 * 864e5); l.push(x); wr(PEND, l);
      return done(200, { id, amount: x.amount, orderId: x.orderId, keyId: LIVE ? KEY : '', demo: !LIVE });
    }
    if (p === '/api/ambulance/confirm' && POST) {
      const b = await body(), l = rd(PEND), x = l.find(y => y.id === c.clean(b.id, 30));
      if (!x) return done(404, { error: 'Booking session expired. Please try again.' });
      const pid = c.clean(b.razorpay_payment_id, 60);
      if (LIVE) {
        const sig = crypto.createHmac('sha256', SEC).update(x.orderId + '|' + pid).digest('hex');
        if (c.clean(b.razorpay_order_id, 60) !== x.orderId || !same(sig, String(b.razorpay_signature || ''))) return done(400, { error: 'Payment could not be verified.' });
      }
      const list = c.readBookings(), now = new Date().toISOString(), q = x.quote || quote(x.option, ADVANCE);
      const saved = { id: x.id, status: 'new', createdAt: now, type: 'medical', service: 'Ambulance', ambType: x.option, item: NAMES[x.option], pickup: x.pickup, drop: x.drop, note: x.note, name: x.name, phone: x.phone, age: x.age, address: x.address,
        date: x.date, slot: x.slot, details: ('Selected: ' + NAMES[x.option] + ' | Pickup: ' + x.pickup + ' | Drop: ' + x.drop + (x.note ? ' | Note: ' + x.note : '') + (x.air && x.air.urgency && x.air.urgency !== 'planned' ? ' | URGENT: ' + (x.air.urgency === 'now' ? 'IMMEDIATELY' : 'TODAY') : '')).slice(0, 700),
        maps: { pickup: mp(x.pickupLL), drop: mp(x.dropLL), address: mp(x.addressLL) }, pickupLL: x.pickupLL || undefined, dropLL: x.dropLL || undefined,
        consent: { agreed: true, at: now }, idProof: { type: x.idType || 'Aadhaar', ext: x.idExt }, air: x.air ? { ...x.air, stage: 'received' } : undefined,
        payment: { status: LIVE ? 'paid' : 'demo', amount: x.amount, total: x.total || x.amount, invoiceNo: 'INV-' + x.id, breakdown: q, mode: LIVE ? 'razorpay' : 'demo', orderId: x.orderId, paymentId: LIVE ? pid : '', at: now },
        history: [{ at: now, event: 'Booking created, ' + (x.option === 'airline' ? 'booking amount (our estimate Rs ' + x.total + ', final price after airline approval)' : 'full payment') + ' Rs ' + x.amount + (LIVE ? ' paid' : ' (DEMO payment, no real money)') }] };
      const opA = (airQuoteFn && airQuoteFn.confirm && (x.option === 'charter' || x.option === 'heli')) ? airQuoteFn.confirm(x.id, x.operatorId || '', x.option) : null;
      if (opA) { saved.operatorId = opA.id; saved.history.push({ at: now, event: 'Air operator assigned: ' + opA.name + (opA.phone ? ' (' + opA.phone + ')' : '') + (opA.changed ? ' - the first operator was no longer free' : '') }); }
      else if (x.operatorId) saved.history.push({ at: now, event: 'NO FREE OPERATOR after payment - please assign an operator manually and call the client' });
      list.push(saved); c.vendors.assign(saved, list); c.saveBookings(list); wr(PEND, l.filter(y => y !== x)); c.notifyMinimal(saved.id);
      try { invoiceFor(saved); } catch (e) { console.log('Ambulance invoice failed:', e.message); }
      const inv = { invoiceNo: 'INV-' + x.id, date: now, bookingId: x.id, paymentId: LIVE ? pid : 'DEMO-' + x.id,
        paymentMode: LIVE ? 'Online payment (Razorpay)' : 'Demo (no real money charged)', status: LIVE ? 'PAID' : 'DEMO',
        client: { name: x.name, mobile: x.phone, address: x.address }, service: NAMES[x.option],
        schedule: 'Date: ' + x.date + ', ' + x.slot + ' | Pickup: ' + x.pickup + ' | Drop: ' + x.drop,
        items: x.option === 'airline' ? [{ label: 'Booking amount (advance). Final price is shared after airline approval and this amount is deducted from it.', amount: x.amount }] : q.items, feePct: x.option === 'airline' ? 0 : q.feePct, gstPct: x.option === 'airline' ? 0 : q.gstPct };
      return done(201, { invoice: inv, message: 'Payment received! Your ambulance request is confirmed. We will call you shortly.', id: saved.id });
    }
    if (p === '/api/admin/booking-doc') {
      if (req.headers['x-admin-key'] !== c.ADMIN_KEY) return done(401, { error: 'Wrong admin key' });
      const bk = c.readBookings().find(y => y.id === c.clean(url.searchParams.get('id'), 30)), k = DOC_KEYS.includes(url.searchParams.get('k')) ? url.searchParams.get('k') : '', nn = Math.min(5, Math.max(1, parseInt(url.searchParams.get('n'), 10) || 1));
      const dk = k && bk && bk.air && bk.air.docs, e = k ? (dk && (nn === 1 ? dk[k] : (dk[k + 'List'] || [])[nn - 1])) : (bk && bk.idProof && bk.idProof.ext);
      if (!e) return done(404, { error: 'No document' });
      try { c.send(res, 200, fs.readFileSync(path.join(DOCS, bk.id + (k ? '-' + k + (nn > 1 ? '-' + nn : '') : '') + '.' + e)), { 'Content-Type': e === 'png' ? 'image/png' : e === 'pdf' ? 'application/pdf' : 'image/jpeg', 'Cache-Control': 'no-store' }); return true; }
      catch { return done(404, { error: 'File missing' }); }
    }
    // admin: tick the document checklist of an airline booking (so no document is missed)
    if (p === '/api/ambulance/air-checklist' && POST) {
      if (req.headers['x-admin-key'] !== c.ADMIN_KEY) return done(401, { error: 'Wrong admin key' });
      const b = await body(), list = c.readBookings(), bk = list.find(y => y.id === c.clean(b.id, 30));
      if (!bk || !bk.air) return done(404, { error: 'Booking not found' });
      const ck = bk.air.checklist = bk.air.checklist || {};
      for (const k of CHECK_KEYS) if (typeof (b.items || {})[k] === 'boolean') ck[k] = b.items[k];
      (bk.history = bk.history || []).push({ at: new Date().toISOString(), event: 'Document checklist updated' });
      c.saveBookings(list); return done(200, { ok: true, checklist: ck, missing: CHECK_KEYS.filter(k => !ck[k]) });
    }
    return done(404, { error: 'Not found' });
  }
  return { handle, getCfg, setAirQuote: f => { airQuoteFn = f; } };
};
