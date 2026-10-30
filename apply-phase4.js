// Ghar to Health - phase 4: Medical dashboard opens from the normal admin login (no separate key box).
// Put this file + admin-medical.html next to server.js, then run:  node apply-phase4.js
const fs = require('fs'), path = require('path');
const pub = path.join(__dirname, 'public'), adminPath = path.join(pub, 'admin.html');
if (!fs.existsSync(adminPath)) { console.error('public/admin.html not found.'); process.exit(1); }
if (!fs.existsSync(path.join(__dirname, 'admin-medical.html'))) { console.error('admin-medical.html not found next to this script.'); process.exit(1); }
let t = fs.readFileSync(adminPath, 'utf8');
function rep(name, find, repl) {
  const n = t.split(find).length - 1;
  if (n !== 1) { console.error(`STOPPED: "${name}" matched ${n} times in admin.html. Nothing was changed.`); process.exit(1); }
  t = t.replace(find, () => repl);
}
rep('medical link', '<h1>Ghar to Health - Admin</h1>',
  '<h1>Ghar to Health - Admin</h1>\n<p style="margin:0 0 12px"><a href="admin-medical.html" style="display:inline-block;padding:9px 16px;border-radius:8px;background:#0b75e0;color:#fff;font-weight:700;text-decoration:none">🩺 Medical Services Dashboard →</a></p>');
rep('fill key after login', 'var data = [];', "var data = [];\nif(sessionStorage.getItem('adminKey'))$('key').value=sessionStorage.getItem('adminKey');");
fs.copyFileSync(adminPath, adminPath + '.bak4'); fs.writeFileSync(adminPath, t);
fs.copyFileSync(path.join(__dirname, 'admin-medical.html'), path.join(pub, 'admin-medical.html'));
console.log('Done. Updated public/admin.html and public/admin-medical.html (backup: admin.html.bak4). No server restart needed.');
