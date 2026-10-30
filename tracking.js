// tracking.js - live partner tracking for Ghar to Health. Put next to server.js
// Uses the EXISTING bookings + vendor login. No links, no tokens to send.
// Road ambulance (van) bookings are tracked too (trip: on the way, reached patient, to hospital, reached hospital). Air ambulances use air-tracking.js.
module.exports = function (c) {
  const live = new Map();          // bookingId -> { state, lat, lng, at, vendorId }
  const STALE = 120000;            // location older than 2 minutes = "waiting for location"
  const hits = new Map();          // ip -> timestamps (rate limit on the public lookup)
  const num = v => typeof v === 'number' && isFinite(v);
  const okXY = (a, b) => num(a) && num(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180;
  const trackable = x => !!x && (x.service !== 'Ambulance' || x.ambType === 'van') && x.type !== 'ambulance' && x.status !== 'cancelled';
  const isVan = x => !!x && x.service === 'Ambulance' && x.ambType === 'van';
  const ONTRIP = { on_the_way: 1, to_hospital: 1 };   // states in which the partner phone sends its location
  const finished = x => x.vendorStatus === 'done' || x.status === 'completed' || x.status === 'cancelled';
  const j = (res, s, o) => { c.send(res, s, o, { 'Cache-Control': 'no-store' }); return true; };
  const addrText = a => String(a || '').replace(/\n?\s*Map:\s*\S+/i, '').trim().slice(0, 300);   // address without the Map: link
  const addrLL = a => { const m = /Map:\s*(\S+)/i.exec(String(a || '')); if (!m) return null; let u = m[1]; try { u = decodeURIComponent(u); } catch {}
    const q = /(-?\d{1,2}\.\d{3,})\s*[, ]\s*(-?\d{1,3}\.\d{3,})/.exec(u); if (!q) return null; return okXY(+q[1], +q[2]) ? { lat: +q[1], lng: +q[2] } : null; };   // exact pin from the client's Map link

  async function run(req, res, url) {
    const p = url.pathname;

    // PARTNER: start trip / send location / arrived / stop
    if (p === '/api/vendor/track' && req.method === 'POST') {
      const v = c.auth(req); if (!v) return j(res, 401, { error: 'Please login again.' });
      let b; try { b = await c.readBody(req, 5000); } catch { return j(res, 400, { error: 'Invalid request.' }); }
      const id = c.clean(b.id, 30), all = c.readBookings(), x = all.find(y => y.id === id && y.vendorId === v.id);
      if (!trackable(x)) return j(res, 404, { error: 'Tracking is not available for this booking.' });
      if (finished(x)) { live.delete(id); return j(res, 200, { state: '' }); }
      if (x.vendorStatus !== 'accepted') return j(res, 400, { error: 'Accept the booking first.' });
      const cur = live.get(id), mine = cur && cur.vendorId === v.id ? cur : null, has = okXY(b.lat, b.lng), at = Date.now();
      const pos = () => ({ lat: has ? b.lat : (mine ? mine.lat : null), lng: has ? b.lng : (mine ? mine.lng : null) });
      const mark = (st, key) => { if (!isVan(x)) return; x.trip = Object.assign(x.trip || {}, { state: st }); if (key) x.trip[key] = at; c.saveBookings(all); };   // van: remember the steps with time
      if (b.action === 'start') { live.set(id, { state: 'on_the_way', ...pos(), at, vendorId: v.id }); mark('on_the_way', 'startAt'); }
      else if (b.action === 'ping') { if (mine && ONTRIP[mine.state] && has) { mine.lat = b.lat; mine.lng = b.lng; mine.at = at; } }
      else if (b.action === 'arrived') { live.set(id, { state: 'arrived', ...pos(), at, vendorId: v.id }); mark('arrived', 'arrivedAt'); }
      else if (b.action === 'pickup' && isVan(x)) { live.set(id, { state: 'to_hospital', ...pos(), at, vendorId: v.id }); mark('to_hospital', 'pickedAt'); }
      else if (b.action === 'reached' && isVan(x)) { live.set(id, { state: 'reached', ...pos(), at, vendorId: v.id }); mark('reached', 'reachedAt'); }
      else if (b.action === 'stop') { live.delete(id); if (isVan(x) && x.trip && x.trip.state !== 'reached') { delete x.trip.state; c.saveBookings(all); } }
      else return j(res, 400, { error: 'Unknown action.' });
      const s = live.get(id); return j(res, 200, { state: s ? s.state : '' });
    }

    // PARTNER: which of my jobs are currently being tracked
    if (p === '/api/vendor/track-state' && req.method === 'GET') {
      const v = c.auth(req); if (!v) return j(res, 401, { error: 'Please login again.' });
      const o = {}; live.forEach((s, id) => { if (s.vendorId === v.id) o[id] = s.state; });
      return j(res, 200, { states: o });
    }

    // CLIENT: live status of a booking (booking ID + mobile number, saved on the client's own phone after booking)
    if (p === '/api/live' && req.method === 'GET') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), t0 = Date.now();
      const h = (hits.get(ip) || []).filter(t => t0 - t < 60000);
      if (h.length >= 120) return j(res, 429, { error: 'Too many requests. Please wait a minute.' });
      h.push(t0); hits.set(ip, h); if (hits.size > 2000) hits.clear();
      const id = c.clean(url.searchParams.get('id'), 30).toUpperCase(), ph = c.clean(url.searchParams.get('phone'), 15).replace(/[\s-]/g, '').slice(-10);
      const x = c.readBookings().find(y => y.id === id && String(y.phone).slice(-10) === ph);
      if (!x) return j(res, 404, { error: 'No booking found.' });
      if (!trackable(x)) return j(res, 200, { id: x.id, tracking: false });
      const s = live.get(x.id), fin = finished(x); if (fin) live.delete(x.id);
      let track = null;
      if (!fin && s && s.vendorId === x.vendorId) {
        const fresh = s.state === 'arrived' || s.state === 'reached' || Date.now() - s.at < STALE, ok = fresh && okXY(s.lat, s.lng);
        track = { state: s.state, at: s.at, stale: !ok, lat: ok ? s.lat : null, lng: ok ? s.lng : null };
      }
      return j(res, 200, { id: x.id, tracking: true, service: x.item || x.service, status: x.status, vendorStatus: x.vendorStatus || '',
        partnerName: x.partnerName || '', date: x.confirmedDate || x.date || '', time: x.confirmedTime || x.slot || '', track,
        ...(isVan(x) ? { ambType: 'van', pickup: x.pickup || '', drop: x.drop || '', pickupLL: x.pickupLL || null, dropLL: x.dropLL || null, trip: x.trip || {}, createdAt: x.createdAt || '' } : { address: addrText(x.address), destLL: addrLL(x.address) }) });
    }

    // ADMIN: all partners that are on a trip right now
    if (p === '/api/admin/live' && req.method === 'GET') {
      if (req.headers['x-admin-key'] !== c.ADMIN_KEY) return j(res, 401, { error: 'Wrong admin key' });
      const list = c.readBookings(), out = [];
      live.forEach((s, id) => {
        const x = list.find(y => y.id === id);
        if (!x || finished(x)) { live.delete(id); return; }
        out.push({ id, service: x.item || x.service, vendorName: x.vendorName || '', state: s.state, lat: s.lat, lng: s.lng, at: s.at });
      });
      return j(res, 200, { live: out });
    }
    return j(res, 405, { error: 'Not allowed' });
  }

  // returns true (synchronously) when the request is a tracking route
  return {
    handle(req, res, url) {
      if (!/^\/api\/(vendor\/track|vendor\/track-state|live|admin\/live)$/.test(url.pathname)) return false;
      run(req, res, url).catch(() => j(res, 500, { error: 'Server error' }));
      return true;
    }
  };
};
