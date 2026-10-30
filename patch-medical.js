// Run once from the project folder (where server.js is):  node patch-medical-2.js
// Flight transfer: only dates at least 3 days from today can be chosen (airline approval takes time).
const fs = require('fs'), path = require('path'), vm = require('vm');
const file = process.argv[2] || path.join(__dirname, 'public', 'medical.html');
let s;
try { s = fs.readFileSync(file, 'utf8'); } catch { console.log('ERROR: file not found: ' + file); process.exit(1); }
if (s.includes('isAirD')) { console.log('Already patched. Nothing to do.'); process.exit(0); }
const edits = [
 [`$('#airBox').hidden=!(d.pay&&p[0]&&p[0].id==='airline');`,
  `$('#airBox').hidden=!(d.pay&&p[0]&&p[0].id==='airline');var isAirD=!!(d.pay&&p[0]&&p[0].id==='airline'),md=new Date(Date.now()+(isAirD?3:0)*864e5);$('#fD').min=md.getFullYear()+'-'+('0'+(md.getMonth()+1)).slice(-2)+'-'+('0'+md.getDate()).slice(-2);if(isAirD&&$('#fD').value&&$('#fD').value<$('#fD').min)$('#fD').value='';`],
 [`<p class="note" style="margin:10px 0 0"><b>Flight transfer details</b> (needed by the airline)</p>`,
  `<p class="note" style="margin:10px 0 0"><b>Flight transfer details</b> (needed by the airline)</p><p class="note" style="color:#c62828;font-weight:700;margin-top:6px">Airline approval can take up to 72 hours. Please choose a travel date at least 3 days from today.</p>`]
];
for (let i = 0; i < edits.length; i++) {
  const n = s.split(edits[i][0]).length - 1;
  if (n !== 1) { console.log('ERROR: change ' + (i + 1) + ' not found exactly once (found ' + n + '). Nothing was changed. Send me your medical.html.'); process.exit(1); }
}
for (const [a, b] of edits) s = s.split(a).join(b);
const scripts = [...s.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
try { scripts.forEach(c => new vm.Script(c)); } catch (e) { console.log('ERROR: script check failed (' + e.message + '). Nothing was changed.'); process.exit(1); }
fs.copyFileSync(file, file + '.bak-before-date');
fs.writeFileSync(file, s);
console.log('OK. medical.html updated (backup: medical.html.bak-before-date). Press Ctrl+F5 in the browser.');
