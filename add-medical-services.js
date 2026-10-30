// Ghar to Health - adds more Medical Services to your site.
// Put this file next to server.js, then run:  node add-medical-services.js
// It makes backups (.bak) and changes nothing if any part does not match.
const fs = require('fs');
const path = require('path');

const MEDICAL = ['Doctor Consultation', 'Medicine Delivery', 'Lab Tests', 'Health Check-up',
  'Nurse at Home', 'Physiotherapy', 'Ambulance', 'Scans & Imaging',
  'Dental Care', 'Eye Care', 'Mental Health', 'Diet & Nutrition'];
const ICONS = { 'Doctor Consultation': '🧑‍⚕️', 'Medicine Delivery': '💊', 'Lab Tests': '🧪', 'Health Check-up': '💙',
  'Nurse at Home': '👩‍⚕️', 'Physiotherapy': '🦴', 'Ambulance': '🚑', 'Scans & Imaging': '🩻',
  'Dental Care': '🦷', 'Eye Care': '👁️', 'Mental Health': '🧠', 'Diet & Nutrition': '🥗' };
const q = list => '[' + list.map(s => "'" + s + "'").join(',') + ']';

const serverPath = path.join(__dirname, 'server.js');
const indexPath = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(fs.existsSync);
if (!fs.existsSync(serverPath) || !indexPath) { console.error('server.js or index.html not found next to this script.'); process.exit(1); }

function patch(file, steps) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [name, find, repl] of steps) {
    const hits = typeof find === 'string' ? text.split(find).length - 1 : (text.match(find) || []).length;
    if (hits !== 1) { console.error(`STOPPED: "${name}" matched ${hits} times in ${path.basename(file)}. Nothing was changed.`); process.exit(1); }
    text = text.replace(find, () => repl);
  }
  return text;
}

const serverOut = patch(serverPath, [
  ['admin key from env', "const ADMIN_KEY = '1234';", "const ADMIN_KEY = process.env.ADMIN_KEY || '1234';"],
  ['server medical list', "medical: ['Doctor Consultation', 'Medicine Delivery', 'Lab Tests', 'Health Check-up']",
    'medical: [' + MEDICAL.map(s => "'" + s + "'").join(', ') + ']']
]);

const renderJs =
  'var MED_ICONS=' + JSON.stringify(ICONS) + ';\n' +
  "function renderMedical(){var g=document.getElementById('medicalGrid');g.innerHTML='';SERVICES.medical.forEach(function(s){var c=document.createElement('div');c.className='service-card';c.innerHTML='<i></i><span></span>';c.firstChild.textContent=MED_ICONS[s]||'💙';c.lastChild.textContent=s;c.addEventListener('click',function(){open('medical',s)});g.appendChild(c)})}\n" +
  'renderMedical();\nfunction fill(sel){';

const indexOut = patch(indexPath, [
  ['css', '/* amc */', '.service-grid.med .service-card:nth-child(n+9){display:none}\n.service-grid.med.open .service-card{display:block}\n\n/* amc */'],
  ['medical tiles', /<div class="service-grid">\s*(?:<div class="service-card" data-type="medical">.*?<\/div>\s*)+<\/div>/s,
    '<div class="service-grid med" id="medicalGrid"></div>'],
  ['js list', "medical:['Doctor Consultation','Medicine Delivery','Lab Tests','Health Check-up']}", 'medical:' + q(MEDICAL) + '}'],
  ['js render', 'function fill(sel){', renderJs],
  ['js refresh after server', 'then(function(d){SERVICES=d})', 'then(function(d){SERVICES=d;renderMedical()})'],
  ['home tiles only', "document.querySelectorAll('.service-card').forEach(function(c){", "document.querySelectorAll('#homeGrid .service-card').forEach(function(c){"],
  ['view all toggle', "if(b.dataset.cat==='medical'){open('medical','Doctor Consultation');return;}",
    "if(b.dataset.cat==='medical'){var g=document.getElementById('medicalGrid');g.classList.toggle('open');b.textContent=g.classList.contains('open')?'Show Less':'View All';return;}"],
  ['sub id', '<p class="sub">Share your details and our team will call you to confirm.</p>', '<p class="sub" id="bookSub">Share your details and our team will call you to confirm.</p>'],
  ['emergency note', "document.getElementById('bookTitle').textContent=t==='medical'?'Book Medical Service':'Book Home Service';",
    "document.getElementById('bookTitle').textContent=t==='medical'?'Book Medical Service':'Book Home Service';document.getElementById('bookSub').textContent=t==='medical'?'Our team will call you to confirm. For emergencies, call 108 right away.':'Share your details and our team will call you to confirm.';"]
]);

fs.copyFileSync(serverPath, serverPath + '.bak');
fs.copyFileSync(indexPath, indexPath + '.bak');
fs.writeFileSync(serverPath, serverOut);
fs.writeFileSync(indexPath, indexOut);
console.log('Done. Restart the server:  node server.js');
console.log('Backups saved as server.js.bak and index.html.bak');
