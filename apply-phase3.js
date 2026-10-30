// Ghar to Health - phase 3: editable Medical services + prices (Home Maintenance is NOT touched).
// Put this file + medical.html + admin-medical.html + medical-services.json next to server.js, then run:  node apply-phase3.js
const fs = require('fs'), path = require('path');
const serverPath = path.join(__dirname, 'server.js'), pub = path.join(__dirname, 'public');
if (!fs.existsSync(serverPath)) { console.error('server.js not found next to this script.'); process.exit(1); }
let t = fs.readFileSync(serverPath, 'utf8');
function rep(name, find, repl) {
  const n = t.split(find).length - 1;
  if (n !== 1) { console.error(`STOPPED: "${name}" matched ${n} times in server.js. Nothing was changed.`); process.exit(1); }
  t = t.replace(find, () => repl);
}
const helpers = `const MED_FILE = path.join(__dirname, 'data', 'medical-services.json');
function readMedical() { try { return JSON.parse(fs.readFileSync(MED_FILE, 'utf8')); } catch { return []; } }
function writeMedical(l) { fs.mkdirSync(path.dirname(MED_FILE), { recursive: true }); fs.writeFileSync(MED_FILE, JSON.stringify(l, null, 2)); }
function medicalCategories() { const c = [...new Set(readMedical().filter(s => s.active !== false).map(s => s.category))]; return c.length ? c : SERVICES.medical; }
const SLOTS = ['Morning (9-12)', 'Afternoon (12-4)', 'Evening (4-8)'];`;
const routes = `if (req.method === 'GET' && url.pathname === '/api/medical-catalog') return send(res, 200, readMedical().filter(s => s.active !== false));
  if (url.pathname === '/api/admin/medical-services') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'Wrong admin key' });
    const cat = readMedical();
    if (req.method === 'GET') return send(res, 200, cat);
    if (req.method === 'DELETE') { writeMedical(cat.filter(s => s.id !== url.searchParams.get('id'))); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' || req.method === 'PUT') {
      let b; try { b = await readBody(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
      if (req.method === 'POST' && b.bulk) {
        const mode = b.bulk.mode, val = Number(b.bulk.value), c = clean(b.bulk.category, 40);
        if (!['percent', 'amount'].includes(mode) || !isFinite(val) || Math.abs(val) > (mode === 'percent' ? 200 : 100000)) return send(res, 400, { error: 'Invalid change value.' });
        let n = 0;
        cat.forEach(s => { if ((!c || s.category === c) && s.price > 0) { s.price = Math.min(100000, Math.max(1, Math.round(mode === 'percent' ? s.price * (1 + val / 100) : s.price + val))); n++; } });
        writeMedical(cat); return send(res, 200, { ok: true, changed: n });
      }
      const item = { category: clean(b.category, 40), name: clean(b.name, 80), description: clean(b.description, 200), price: Number(b.price), duration: clean(b.duration, 40), active: b.active !== false };
      if (!item.category || item.name.length < 2 || !(item.price >= 0 && item.price <= 100000)) return send(res, 400, { error: 'Category, name and a valid price (0 = on request) are required.' });
      if (req.method === 'POST') { item.id = 'm' + Date.now().toString(36); cat.push(item); }
      else { const i = cat.findIndex(s => s.id === b.id); if (i < 0) return send(res, 404, { error: 'Not found' }); cat[i] = { ...cat[i], ...item }; }
      writeMedical(cat); return send(res, 200, { ok: true });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/services')`;
rep('helpers', "const SLOTS = ['Morning (9-12)', 'Afternoon (12-4)', 'Evening (4-8)'];", helpers);
rep('routes', "if (req.method === 'GET' && url.pathname === '/api/services')", routes);
rep('booking category check', 'if (!SERVICES.medical.includes(m.service))', 'if (!medicalCategories().includes(m.service))');
rep('homepage tiles', '{ home: homeServices(), medical: SERVICES.medical }', '{ home: homeServices(), medical: medicalCategories() }');
fs.copyFileSync(serverPath, serverPath + '.bak3'); fs.writeFileSync(serverPath, t);
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const seed = path.join(__dirname, 'medical-services.json'), seedTo = path.join(__dirname, 'data', 'medical-services.json');
if (fs.existsSync(seed) && !fs.existsSync(seedTo)) { fs.copyFileSync(seed, seedTo); console.log('Starter medical services saved to data/medical-services.json'); }
fs.mkdirSync(pub, { recursive: true });
for (const f of ['medical.html', 'admin-medical.html']) { if (fs.existsSync(path.join(__dirname, f))) { fs.copyFileSync(path.join(__dirname, f), path.join(pub, f)); console.log('Updated public/' + f); } else console.log('Missing next to script: ' + f); }
console.log('Done. Restart the server: node server.js   (backup: server.js.bak3)');
