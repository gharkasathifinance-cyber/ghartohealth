// auth.js - Customer phone + OTP login (plain Node, no Express)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logs = require('./logs');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');   // logins survive a server restart
const ID_PREFIX = 'GTHU';                       // GTHU001, GTHU002 ...
const OTP_SECRET = process.env.OTP_SECRET || 'ght-otp-secret-change-me';
const OTP_TTL = 5 * 60 * 1000;
const MAX_TRIES = 3;
const SEND_WINDOW = 10 * 60 * 1000;
const MAX_SENDS = 3;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

const otps = new Map();      // phone -> { hash, exp, tries, name }
const sends = new Map();     // phone -> [timestamps]
function loadSessions() {
  try {
    const o = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    return Object.entries(o).filter(([, s]) => s.exp > Date.now());
  } catch { return []; }
}
function saveSessions() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)));
  } catch (e) { console.log('Session save failed:', e.message); }
}
const BLOCKED_MSG = 'This account is blocked. Please contact Ghar to Health.';
const sessions = new Map(loadSessions());   // token -> { userId, name, phone, exp }

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return { counter: 0, users: [] }; }
}
function writeUsers(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2));
}
function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '').slice(-10);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
function otpHash(phone, otp) {
  return crypto.createHmac('sha256', OTP_SECRET).update(phone + ':' + otp).digest('hex');
}

// SMS provider abhi connect nahi hai. Jab tak connect nahi hota, OTP server console mein dikhega.
async function sendSms(phone, otp) {
  if (!process.env.SMS_PROVIDER) {
    console.log(`[OTP-DEV] ${phone} -> ${otp}`);
    return;
  }
  throw new Error('SMS provider is not configured yet');
}

function tokenFromReq(req) {
  const m = /(?:^|;\s*)ght_session=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function isBlocked(userId) {
  const u = readUsers().users.find(x => x.userId === userId);
  return !!(u && u.blocked);
}
function getSession(req) {
  const t = tokenFromReq(req);
  if (!t) return null;
  const s = sessions.get(t);
  if (!s || s.exp < Date.now() || isBlocked(s.userId)) { sessions.delete(t); return null; }
  return s;
}

async function handle(req, res, url, { send, readBody, clean, ADMIN_KEY }) {
  const p = url.pathname;

  if (req.method === 'POST' && p === '/api/auth/send-otp') {
    let b; try { b = await readBody(req); } catch { send(res, 400, { error: 'Invalid request.' }); return true; }
    const phone = normalizePhone(b.phone);
    const name = clean(b.name, 80);
    if (!phone) { send(res, 400, { error: 'Please enter a valid 10-digit mobile number.' }); return true; }
    const db = readUsers();
    const existing = db.users.find(u => u.phone === phone);
    if (existing && existing.blocked) { send(res, 403, { error: BLOCKED_MSG }); return true; }
    if (!existing && name.length < 2) { send(res, 400, { error: 'Please enter your name.' }); return true; }
    const now = Date.now();
    const recent = (sends.get(phone) || []).filter(t => now - t < SEND_WINDOW);
    if (recent.length >= MAX_SENDS) { send(res, 429, { error: 'Too many requests. Please try again later.' }); return true; }
    const otp = String(crypto.randomInt(100000, 1000000));
    otps.set(phone, { hash: otpHash(phone, otp), exp: now + OTP_TTL, tries: 0, name: existing ? existing.name : name });
    recent.push(now); sends.set(phone, recent);
    try { await sendSms(phone, otp); }
    catch (e) { console.log('OTP send failed:', e.message); send(res, 500, { error: 'Could not send OTP right now.' }); return true; }
    send(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && p === '/api/auth/verify-otp') {
    let b; try { b = await readBody(req); } catch { send(res, 400, { error: 'Invalid request.' }); return true; }
    const phone = normalizePhone(b.phone);
    const otp = String(b.otp || '').replace(/\D/g, '');
    const e = phone ? otps.get(phone) : null;
    if (!e || e.exp < Date.now()) { send(res, 400, { error: 'OTP has expired. Please request a new one.' }); return true; }
    if (e.tries >= MAX_TRIES) { otps.delete(phone); send(res, 429, { error: 'Too many wrong attempts. Please request a new OTP.' }); return true; }
    const A = Buffer.from(e.hash), B2 = Buffer.from(otpHash(phone, otp));
    if (A.length !== B2.length || !crypto.timingSafeEqual(A, B2)) {
      e.tries++; send(res, 400, { error: 'Incorrect OTP.' }); return true;
    }
    otps.delete(phone);

    const db = readUsers();
    const now = new Date().toISOString();
    let u = db.users.find(x => x.phone === phone);
    if (u && u.blocked) { send(res, 403, { error: BLOCKED_MSG }); return true; }
    let isNew = false;
    if (!u) {
      db.counter += 1;
      u = { userId: ID_PREFIX + String(db.counter).padStart(3, '0'), name: e.name, phone, createdAt: now, lastLoginAt: now };
      db.users.push(u);
      isNew = true;
    } else {
      u.lastLoginAt = now;
    }
    writeUsers(db);

    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId: u.userId, name: u.name, phone, exp: Date.now() + SESSION_TTL });
    saveSessions();
    logs.appendLogin({ name: u.name, phone: u.phone, userId: u.userId });

    send(res, 200, { ok: true, userId: u.userId, name: u.name, isNew },
      { 'Set-Cookie': `ght_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}` });
    return true;
  }

  if (req.method === 'GET' && p === '/api/auth/me') {
    const s = getSession(req);
    if (!s) { send(res, 401, { loggedIn: false }); return true; }
    send(res, 200, { loggedIn: true, userId: s.userId, name: s.name });
    return true;
  }

  if (req.method === 'POST' && p === '/api/auth/logout') {
    const t = tokenFromReq(req);
    if (t) { sessions.delete(t); saveSessions(); }
    send(res, 200, { ok: true }, { 'Set-Cookie': 'ght_session=; HttpOnly; Path=/; Max-Age=0' });
    return true;
  }

  if (p === '/api/admin/users' || p === '/api/admin/users/block') {
    if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) { send(res, 401, { error: 'Wrong admin key' }); return true; }
    if (req.method === 'GET' && p === '/api/admin/users') {
      send(res, 200, { ok: true, users: readUsers().users.map(u => ({ userId: u.userId, name: u.name, phone: u.phone, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, blocked: !!u.blocked })) });
      return true;
    }
    if (req.method === 'POST' && p === '/api/admin/users/block') {
      let b; try { b = await readBody(req); } catch { send(res, 400, { error: 'Invalid request.' }); return true; }
      const db = readUsers(); const u = db.users.find(x => x.userId === String(b.userId || ''));
      if (!u) { send(res, 404, { error: 'User not found' }); return true; }
      u.blocked = !!b.blocked; writeUsers(db);
      if (u.blocked) { for (const [tk, s] of sessions) if (s.userId === u.userId) sessions.delete(tk); saveSessions(); }
      send(res, 200, { ok: true, userId: u.userId, blocked: u.blocked });
      return true;
    }
  }
  return false;
}

module.exports = { handle, getSession };
