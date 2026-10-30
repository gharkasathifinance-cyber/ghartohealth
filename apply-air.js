// Run once from the project folder:  node apply-air.js
// It makes a backup of server.js and ambulance.js, then connects air-tracking.js. Safe to run twice.
const fs = require('fs'), path = require('path');
const dir = __dirname, S = path.join(dir, 'server.js'), A = path.join(dir, 'ambulance.js');
const fail = m => { console.log('\nSTOP: ' + m + '\nNothing was changed.'); process.exit(1); };
for (const f of [S, A, path.join(dir, 'air-tracking.js')]) if (!fs.existsSync(f)) fail(path.basename(f) + ' not found in this folder. Run this from ghar_to_health_platform.');
for (const f of ['public/air-track.html', 'public/admin-air.html']) if (!fs.existsSync(path.join(dir, f))) fail(f + ' not found. Copy the public files first.');

let s = fs.readFileSync(S, 'utf8'), a = fs.readFileSync(A, 'utf8'), changed = [];

// 1. ambulance.js must share its charges with the new module
if (!/return \{ handle, getCfg \};/.test(a)) {
  const re = /return \{ handle \};(\s*)\};(\s*)$/;
  if (!re.test(a)) fail('ambulance.js ending was not recognised.');
  a = a.replace(re, 'return { handle, getCfg };$1};$2'); changed.push('ambulance.js');
}
// 2. server.js: create the module and let it answer /api/air/...
if (!/require\('\.\/air-tracking'\)/.test(s)) {
  const l1 = /(const ambulance = require\('\.\/ambulance'\)\([^\n]*\);\r?\n)/, l2 = /([ \t]*if \(await ambulance\.handle\(req, res, url\)\) return;\r?\n)/;
  if (!l1.test(s) || !l2.test(s)) fail('server.js lines were not recognised (ambulance lines). Send server.js again.');
  s = s.replace(l1, "$1const airTracking = require('./air-tracking')({ readBookings, saveBookings, readBody, send, clean, ADMIN_KEY, ambulance });\n")
       .replace(l2, '$1  if (await airTracking.handle(req, res, url)) return;\n'); changed.push('server.js');
}
if (!changed.length) { console.log('Already connected. Nothing to do.'); process.exit(0); }
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
if (changed.includes('server.js')) { fs.copyFileSync(S, S + '.before-air-' + stamp); fs.writeFileSync(S, s); }
if (changed.includes('ambulance.js')) { fs.copyFileSync(A, A + '.before-air-' + stamp); fs.writeFileSync(A, a); }
console.log('Done. Updated: ' + changed.join(', ') + '. Backups saved with ".before-air-" in the name.');
console.log('Now restart the server (Ctrl+C, then: node server.js).');
console.log('Admin page:    http://localhost:3000/admin-air.html');
console.log('Customer page: http://localhost:3000/air-track.html');
