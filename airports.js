/* airports.js - Ghar to Health
 * Nearest-airport finder for the Pickup & drop box.
 * NOTE: coordinates are approximate. Verify before launch.
 * To add an airstrip / helipad: add a row with type: "airstrip" or "helipad".
 * type "jet" = scheduled airport where charter jets can land.
 */
const AIRPORTS = [
  // Chhattisgarh
  { name: "Swami Vivekananda Airport", city: "Raipur", state: "Chhattisgarh", lat: 21.1804, lng: 81.7388, type: "jet" },
  { name: "Bilaspur Airport", city: "Bilaspur", state: "Chhattisgarh", lat: 21.9884, lng: 82.1110, type: "jet" },
  { name: "Jagdalpur Airport", city: "Jagdalpur", state: "Chhattisgarh", lat: 19.0743, lng: 82.0368, type: "jet" },
  // Madhya Pradesh
  { name: "Raja Bhoj Airport", city: "Bhopal", state: "Madhya Pradesh", lat: 23.2875, lng: 77.3374, type: "jet" },
  { name: "Devi Ahilyabai Holkar Airport", city: "Indore", state: "Madhya Pradesh", lat: 22.7218, lng: 75.8011, type: "jet" },
  { name: "Jabalpur Airport (Dumna)", city: "Jabalpur", state: "Madhya Pradesh", lat: 23.1778, lng: 80.0520, type: "jet" },
  { name: "Gwalior Airport", city: "Gwalior", state: "Madhya Pradesh", lat: 26.2933, lng: 78.2278, type: "jet" },
  { name: "Khajuraho Airport", city: "Khajuraho", state: "Madhya Pradesh", lat: 24.8172, lng: 79.9186, type: "jet" },
  // Maharashtra
  { name: "Chhatrapati Shivaji Maharaj Intl Airport", city: "Mumbai", state: "Maharashtra", lat: 19.0896, lng: 72.8656, type: "jet" },
  { name: "Navi Mumbai Intl Airport", city: "Navi Mumbai", state: "Maharashtra", lat: 18.9923, lng: 73.0713, type: "jet" },
  { name: "Pune Airport (Lohegaon)", city: "Pune", state: "Maharashtra", lat: 18.5821, lng: 73.9197, type: "jet" },
  { name: "Dr. Babasaheb Ambedkar Intl Airport", city: "Nagpur", state: "Maharashtra", lat: 21.0922, lng: 79.0472, type: "jet" },
  { name: "Aurangabad Airport (Chikalthana)", city: "Aurangabad", state: "Maharashtra", lat: 19.8627, lng: 75.3981, type: "jet" },
  { name: "Nashik Airport (Ozar)", city: "Nashik", state: "Maharashtra", lat: 20.1192, lng: 73.9129, type: "jet" },
  { name: "Kolhapur Airport", city: "Kolhapur", state: "Maharashtra", lat: 16.6647, lng: 74.2894, type: "jet" },
  { name: "Shirdi Airport", city: "Shirdi", state: "Maharashtra", lat: 19.6886, lng: 74.3789, type: "jet" },
  // Delhi NCR / North
  { name: "Indira Gandhi Intl Airport", city: "Delhi", state: "Delhi", lat: 28.5562, lng: 77.1000, type: "jet" },
  { name: "Hindon Airport", city: "Ghaziabad", state: "Uttar Pradesh", lat: 28.7003, lng: 77.4125, type: "jet" },
  { name: "Chaudhary Charan Singh Intl Airport", city: "Lucknow", state: "Uttar Pradesh", lat: 26.7606, lng: 80.8893, type: "jet" },
  { name: "Lal Bahadur Shastri Intl Airport", city: "Varanasi", state: "Uttar Pradesh", lat: 25.4524, lng: 82.8593, type: "jet" },
  { name: "Maharishi Valmiki Intl Airport", city: "Ayodhya", state: "Uttar Pradesh", lat: 26.7006, lng: 82.1550, type: "jet" },
  { name: "Gorakhpur Airport", city: "Gorakhpur", state: "Uttar Pradesh", lat: 26.7397, lng: 83.4497, type: "jet" },
  { name: "Prayagraj Airport (Bamrauli)", city: "Prayagraj", state: "Uttar Pradesh", lat: 25.4401, lng: 81.7339, type: "jet" },
  { name: "Kanpur Airport (Chakeri)", city: "Kanpur", state: "Uttar Pradesh", lat: 26.4044, lng: 80.4101, type: "jet" },
  { name: "Agra Airport (Kheria)", city: "Agra", state: "Uttar Pradesh", lat: 27.1558, lng: 77.9609, type: "jet" },
  { name: "Jolly Grant Airport", city: "Dehradun", state: "Uttarakhand", lat: 30.1897, lng: 78.1803, type: "jet" },
  { name: "Pantnagar Airport", city: "Pantnagar", state: "Uttarakhand", lat: 29.0334, lng: 79.4737, type: "jet" },
  { name: "Chandigarh Intl Airport", city: "Chandigarh", state: "Chandigarh", lat: 30.6735, lng: 76.7885, type: "jet" },
  { name: "Sri Guru Ram Dass Jee Intl Airport", city: "Amritsar", state: "Punjab", lat: 31.7096, lng: 74.7973, type: "jet" },
  { name: "Jammu Airport", city: "Jammu", state: "Jammu & Kashmir", lat: 32.6891, lng: 74.8374, type: "jet" },
  { name: "Srinagar Airport", city: "Srinagar", state: "Jammu & Kashmir", lat: 33.9871, lng: 74.7742, type: "jet" },
  { name: "Kushok Bakula Rimpochee Airport", city: "Leh", state: "Ladakh", lat: 34.1359, lng: 77.5465, type: "jet" },
  // Rajasthan
  { name: "Jaipur Intl Airport", city: "Jaipur", state: "Rajasthan", lat: 26.8242, lng: 75.8122, type: "jet" },
  { name: "Maharana Pratap Airport (Dabok)", city: "Udaipur", state: "Rajasthan", lat: 24.6177, lng: 73.8961, type: "jet" },
  { name: "Jodhpur Airport", city: "Jodhpur", state: "Rajasthan", lat: 26.2511, lng: 73.0489, type: "jet" },
  { name: "Jaisalmer Airport", city: "Jaisalmer", state: "Rajasthan", lat: 26.8887, lng: 70.8650, type: "jet" },
  // Gujarat
  { name: "Sardar Vallabhbhai Patel Intl Airport", city: "Ahmedabad", state: "Gujarat", lat: 23.0772, lng: 72.6347, type: "jet" },
  { name: "Surat Airport", city: "Surat", state: "Gujarat", lat: 21.1141, lng: 72.7418, type: "jet" },
  { name: "Vadodara Airport", city: "Vadodara", state: "Gujarat", lat: 22.3362, lng: 73.2263, type: "jet" },
  { name: "Rajkot Intl Airport (Hirasar)", city: "Rajkot", state: "Gujarat", lat: 22.3779, lng: 71.0455, type: "jet" },
  { name: "Bhavnagar Airport", city: "Bhavnagar", state: "Gujarat", lat: 21.7522, lng: 72.1852, type: "jet" },
  { name: "Bhuj Airport (Rudra Mata)", city: "Bhuj", state: "Gujarat", lat: 23.2878, lng: 69.6702, type: "jet" },
  // East
  { name: "Netaji Subhas Chandra Bose Intl Airport", city: "Kolkata", state: "West Bengal", lat: 22.6547, lng: 88.4467, type: "jet" },
  { name: "Bagdogra Airport", city: "Siliguri", state: "West Bengal", lat: 26.6812, lng: 88.3286, type: "jet" },
  { name: "Jay Prakash Narayan Airport", city: "Patna", state: "Bihar", lat: 25.5913, lng: 85.0880, type: "jet" },
  { name: "Gaya Airport", city: "Gaya", state: "Bihar", lat: 24.7443, lng: 84.9512, type: "jet" },
  { name: "Darbhanga Airport", city: "Darbhanga", state: "Bihar", lat: 26.1947, lng: 85.9174, type: "jet" },
  { name: "Birsa Munda Airport", city: "Ranchi", state: "Jharkhand", lat: 23.3143, lng: 85.3217, type: "jet" },
  { name: "Sonari Airport", city: "Jamshedpur", state: "Jharkhand", lat: 22.8132, lng: 86.1693, type: "jet" },
  { name: "Biju Patnaik Intl Airport", city: "Bhubaneswar", state: "Odisha", lat: 20.2444, lng: 85.8178, type: "jet" },
  { name: "Veer Surendra Sai Airport", city: "Jharsuguda", state: "Odisha", lat: 21.9135, lng: 84.0504, type: "jet" },
  { name: "Rourkela Airport", city: "Rourkela", state: "Odisha", lat: 22.2566, lng: 84.8146, type: "jet" },
  // North-East
  { name: "Lokpriya Gopinath Bordoloi Intl Airport", city: "Guwahati", state: "Assam", lat: 26.1061, lng: 91.5859, type: "jet" },
  { name: "Dibrugarh Airport", city: "Dibrugarh", state: "Assam", lat: 27.4839, lng: 95.0169, type: "jet" },
  { name: "Silchar Airport", city: "Silchar", state: "Assam", lat: 24.9129, lng: 92.9787, type: "jet" },
  { name: "Imphal Intl Airport", city: "Imphal", state: "Manipur", lat: 24.7600, lng: 93.8967, type: "jet" },
  { name: "Agartala Airport", city: "Agartala", state: "Tripura", lat: 23.8870, lng: 91.2404, type: "jet" },
  { name: "Dimapur Airport", city: "Dimapur", state: "Nagaland", lat: 25.8839, lng: 93.7711, type: "jet" },
  { name: "Shillong Airport (Umroi)", city: "Shillong", state: "Meghalaya", lat: 25.7036, lng: 91.9786, type: "jet" },
  { name: "Lengpui Airport", city: "Aizawl", state: "Mizoram", lat: 23.8406, lng: 92.6197, type: "jet" },
  { name: "Pakyong Airport", city: "Gangtok", state: "Sikkim", lat: 27.2275, lng: 88.5870, type: "jet" },
  // South
  { name: "Rajiv Gandhi Intl Airport", city: "Hyderabad", state: "Telangana", lat: 17.2403, lng: 78.4294, type: "jet" },
  { name: "Visakhapatnam Airport", city: "Visakhapatnam", state: "Andhra Pradesh", lat: 17.7212, lng: 83.2245, type: "jet" },
  { name: "Vijayawada Airport (Gannavaram)", city: "Vijayawada", state: "Andhra Pradesh", lat: 16.5304, lng: 80.7968, type: "jet" },
  { name: "Rajahmundry Airport", city: "Rajahmundry", state: "Andhra Pradesh", lat: 17.1103, lng: 81.8182, type: "jet" },
  { name: "Tirupati Airport", city: "Tirupati", state: "Andhra Pradesh", lat: 13.6325, lng: 79.5433, type: "jet" },
  { name: "Kempegowda Intl Airport", city: "Bengaluru", state: "Karnataka", lat: 13.1986, lng: 77.7066, type: "jet" },
  { name: "Mangaluru Intl Airport", city: "Mangaluru", state: "Karnataka", lat: 12.9613, lng: 74.8901, type: "jet" },
  { name: "Hubballi Airport", city: "Hubballi", state: "Karnataka", lat: 15.3617, lng: 75.0849, type: "jet" },
  { name: "Belagavi Airport", city: "Belagavi", state: "Karnataka", lat: 15.8593, lng: 74.6183, type: "jet" },
  { name: "Mysuru Airport", city: "Mysuru", state: "Karnataka", lat: 12.2300, lng: 76.6558, type: "jet" },
  { name: "Chennai Intl Airport", city: "Chennai", state: "Tamil Nadu", lat: 12.9941, lng: 80.1709, type: "jet" },
  { name: "Coimbatore Intl Airport", city: "Coimbatore", state: "Tamil Nadu", lat: 11.0300, lng: 77.0434, type: "jet" },
  { name: "Madurai Airport", city: "Madurai", state: "Tamil Nadu", lat: 9.8345, lng: 78.0934, type: "jet" },
  { name: "Tiruchirappalli Intl Airport", city: "Tiruchirappalli", state: "Tamil Nadu", lat: 10.7654, lng: 78.7097, type: "jet" },
  { name: "Cochin Intl Airport", city: "Kochi", state: "Kerala", lat: 10.1520, lng: 76.4019, type: "jet" },
  { name: "Trivandrum Intl Airport", city: "Thiruvananthapuram", state: "Kerala", lat: 8.4821, lng: 76.9201, type: "jet" },
  { name: "Calicut Intl Airport", city: "Kozhikode", state: "Kerala", lat: 11.1368, lng: 75.9553, type: "jet" },
  // West coast / islands
  { name: "Goa Intl Airport (Dabolim)", city: "Goa", state: "Goa", lat: 15.3808, lng: 73.8314, type: "jet" },
  { name: "Manohar Intl Airport (Mopa)", city: "Mopa", state: "Goa", lat: 15.7130, lng: 73.8640, type: "jet" },
  { name: "Veer Savarkar Intl Airport", city: "Port Blair", state: "Andaman & Nicobar", lat: 11.6412, lng: 92.7297, type: "jet" }
  // Add more airports, airstrips and helipads here.
];

const FAR_KM = 30; // beyond this, suggest ground ambulance
const SAME_CITY_KM = 25; // an airport within this distance counts as "in the city"

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const r = d => d * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* aircraft: "charter" | "airline" | "helicopter" (helicopter can use any type) */
function nearestAirports(lat, lng, count, aircraft) {
  count = count || 3;
  let list = AIRPORTS;
  if (aircraft === "charter" || aircraft === "airline") {
    list = list.filter(a => a.type === "jet");
  }
  return list
    .map(a => Object.assign({}, a, { km: Math.round(distanceKm(lat, lng, a.lat, a.lng)) }))
    .sort((x, y) => x.km - y.km)
    .slice(0, count);
}

/* Returns what the UI should show for a selected city.
 * { hasAirport, note, options[], needGroundAmbulance }
 */
function airportsForCity(cityName, lat, lng, aircraft) {
  const near = nearestAirports(lat, lng, 3, aircraft);
  const city = (cityName || "").trim().toLowerCase();
  const inCity = near.filter(a =>
    a.city.toLowerCase() === city || a.km <= SAME_CITY_KM);
  const hasAirport = inCity.length > 0;
  const shown = hasAirport ? inCity.concat(near.filter(a => !inCity.includes(a))) : near;

  let note;
  if (hasAirport) {
    note = "Airports for " + cityName + ":";
  } else {
    note = "No airport in " + cityName + ". Nearest airports: " +
      near.map(a => a.city + " (" + a.name + ", " + a.km + " km)").join(", ");
  }
  return {
    hasAirport: hasAirport,
    note: note,
    options: shown,
    needGroundAmbulance: shown.length ? shown[0].km > FAR_KM : true
  };
}

/* UI helper.
 * selectEl  : the <select> for airports
 * noteEl    : an element where the note line is shown
 * ambSelect : the Yes/No <select> for ground ambulance (optional)
 * onChange  : called with the selected airport object
 */
function fillAirportDropdown(selectEl, noteEl, ambSelect, cityName, lat, lng, aircraft, onChange) {
  const res = airportsForCity(cityName, lat, lng, aircraft);
  selectEl.innerHTML = "";
  res.options.forEach((a, i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = a.name + ", " + a.city + " (" + a.km + " km)";
    selectEl.appendChild(o);
  });
  noteEl.textContent = res.note;
  if (res.needGroundAmbulance) {
    noteEl.textContent += (res.options.length && res.options[0].km > FAR_KM)
      ? "  Airport is " + res.options[0].km + " km away. We recommend a ground ambulance." : "";
    if (ambSelect) ambSelect.value = "Yes";
  }
  selectEl.onchange = () => {
    const a = res.options[selectEl.value];
    if (ambSelect) ambSelect.value = a.km > FAR_KM ? "Yes" : ambSelect.value;
    if (onChange) onChange(a);
  };
  if (onChange && res.options.length) onChange(res.options[0]);
  return res;
}

if (typeof module !== "undefined") {
  module.exports = { AIRPORTS, nearestAirports, airportsForCity, distanceKm };
}
