'use strict';
/**
 * Milao — stranger chat, matched by a computed character.
 * Zero dependencies. Node 18+.
 *
 *   node server.js
 *   PORT=3000 ADMIN_TOKEN=secret node server.js
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { makeStore } = require('./store');
const crypto = require('node:crypto');
const os = require('node:os');
/* astrology engine, inlined so the repo stays flat */
const astro = (() => {

/**
 * astro.js — every chart this app needs, computed from birth data.
 * No dependencies. Moon validated to <0.07° against astropy's ephemeris;
 * planets use JPL's approximate Keplerian elements (good to a degree or so,
 * which is far tighter than a 30° sign boundary).
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const norm360 = x => ((x % 360) + 360) % 360;

/* ---------------- time ---------------- */
function julianDay(y, mo, d, hourUT) {
  if (mo <= 2) { y -= 1; mo += 12; }
  const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (mo + 1)) + d + B - 1524.5 + hourUT / 24;
}
function jdFromLocal(dateStr, timeStr, tzHours) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '12:00').split(':').map(Number);
  return julianDay(y, mo, d, hh + mm / 60 - (tzHours == null ? 5.5 : tzHours));
}

/* ---------------- the Moon (Meeus ch.47, truncated) ---------------- */
function moonLongitude(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  const Lp = 218.3164477 + 481267.88123421*T - 0.0015786*T*T + Math.pow(T,3)/538841 - Math.pow(T,4)/65194000;
  const D  = 297.8501921 + 445267.1114034*T - 0.0018819*T*T + Math.pow(T,3)/545868 - Math.pow(T,4)/113065000;
  const M  = 357.5291092 + 35999.0502909*T - 0.0001536*T*T + Math.pow(T,3)/24490000;
  const Mp = 134.9633964 + 477198.8675055*T + 0.0087414*T*T + Math.pow(T,3)/69699 - Math.pow(T,4)/14712000;
  const F  = 93.2720950 + 483202.0175233*T - 0.0036539*T*T - Math.pow(T,3)/3526000 + Math.pow(T,4)/863310000;
  const A1 = 119.75 + 131.849*T, A2 = 53.09 + 479264.290*T;
  const E = 1 - 0.002516*T - 0.0000074*T*T;
  const terms = [
    [6288774,0,0,1,0],[1274027,2,0,-1,0],[658314,2,0,0,0],[213618,0,0,2,0],
    [-185116,0,1,0,0],[-114332,0,0,0,2],[58793,2,0,-2,0],[57066,2,-1,-1,0],
    [53322,2,0,1,0],[45758,2,-1,0,0],[-40923,0,1,-1,0],[-34720,1,0,0,0],
    [-30383,0,1,1,0],[15327,2,0,0,-2],[-12528,0,0,1,2],[10980,0,0,1,-2],
    [10675,2,0,-1,2],[10034,2,0,1,2],[8548,2,0,-1,-2],[-7888,0,1,2,0],
    [-6766,0,1,-2,0],[-5163,1,0,-1,0],[4987,1,0,1,0],[4036,2,-1,1,0],
    [3994,2,0,2,0],[3861,2,0,-2,-2],[3665,2,-1,-2,0],[-2689,0,1,-1,2],
    [-2602,2,0,-1,-2],[2390,2,-1,0,2],[2348,1,0,0,-2],[2236,2,0,-2,2],
    [-2120,0,1,2,2],[-2069,0,2,0,0],[2048,2,-1,0,-2],[-1773,2,0,1,-2],
    [-1595,2,0,0,2],[1215,0,1,0,2],[-1110,0,0,2,2]
  ];
  let s = 0;
  for (const [c, dD, dM, dMp, dF] of terms) {
    let term = c * Math.sin((dD*D + dM*M + dMp*Mp + dF*F) * D2R);
    if (Math.abs(dM) === 1) term *= E; else if (Math.abs(dM) === 2) term *= E*E;
    s += term;
  }
  s += 3958*Math.sin(A1*D2R) + 1962*Math.sin((Lp-F)*D2R) + 318*Math.sin(A2*D2R);
  const omega = 125.04452 - 1934.136261*T;
  return norm360(Lp + s/1e6 - 17.20*Math.sin(omega*D2R)/3600);
}

/* ---------------- planets (JPL approximate elements, 1800–2050) ---------------- */
const ELEMENTS = {
  earth:   { a:[1.00000261,0.00000562], e:[0.01671123,-0.00004392], i:[-0.00001531,-0.01294668], L:[100.46457166,35999.37244981], w:[102.93768193,0.32327364],  node:[0,0] },
  venus:   { a:[0.72333566,0.00000390], e:[0.00677672,-0.00004107], i:[3.39467605,-0.00078890],  L:[181.97909950,58517.81538729], w:[131.60246718,0.00268329], node:[76.67984255,-0.27769418] },
  mars:    { a:[1.52371034,0.00001847], e:[0.09339410,0.00007882],  i:[1.84969142,-0.00813131],  L:[-4.55343205,19140.30268499], w:[-23.94362959,0.44441088], node:[49.55953891,-0.29257343] }
};
function heliocentric(el, T) {
  const a = el.a[0] + el.a[1]*T, e = el.e[0] + el.e[1]*T;
  const I = (el.i[0] + el.i[1]*T) * D2R;
  const L = el.L[0] + el.L[1]*T;
  const wbar = el.w[0] + el.w[1]*T;
  const node = (el.node[0] + el.node[1]*T) * D2R;
  const w = (wbar - el.node[0] - el.node[1]*T) * D2R;
  let M = norm360(L - wbar) * D2R;
  let E = M;
  for (let k = 0; k < 8; k++) E = E - (E - e*Math.sin(E) - M) / (1 - e*Math.cos(E));
  const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e*e) * Math.sin(E);
  const v = Math.atan2(yv, xv), r = Math.hypot(xv, yv);
  const u = v + w;
  const x = r * (Math.cos(node)*Math.cos(u) - Math.sin(node)*Math.sin(u)*Math.cos(I));
  const y = r * (Math.sin(node)*Math.cos(u) + Math.cos(node)*Math.sin(u)*Math.cos(I));
  const z = r * Math.sin(u) * Math.sin(I);
  return { x, y, z };
}
function geoLongitude(planet, jd) {
  const T = (jd - 2451545.0) / 36525.0;
  const p = heliocentric(ELEMENTS[planet], T);
  const e = heliocentric(ELEMENTS.earth, T);
  return norm360(Math.atan2(p.y - e.y, p.x - e.x) * R2D);
}
function sunLongitude(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  const e = heliocentric(ELEMENTS.earth, T);      // Earth's heliocentric position
  return norm360(Math.atan2(-e.y, -e.x) * R2D);   // the Sun sits opposite
}

const lahiriAyanamsa = jd => 23.8532 + 0.0139694 * ((jd - 2451545.0) / 365.25);


/* ---------------- places (lat, lon, tz hours) ---------------- */
const CITIES = {
  "bengaluru":[12.972,77.594,5.5], "bangalore":[12.972,77.594,5.5], "mumbai":[19.076,72.877,5.5],
  "bombay":[19.076,72.877,5.5], "delhi":[28.614,77.209,5.5], "new delhi":[28.614,77.209,5.5],
  "kolkata":[22.573,88.364,5.5], "calcutta":[22.573,88.364,5.5], "chennai":[13.083,80.271,5.5],
  "madras":[13.083,80.271,5.5], "hyderabad":[17.385,78.487,5.5], "pune":[18.520,73.856,5.5],
  "ahmedabad":[23.023,72.571,5.5], "jaipur":[26.912,75.787,5.5], "lucknow":[26.847,80.947,5.5],
  "kanpur":[26.449,80.331,5.5], "nagpur":[21.146,79.088,5.5], "indore":[22.720,75.857,5.5],
  "bhopal":[23.260,77.413,5.5], "patna":[25.594,85.138,5.5], "vadodara":[22.307,73.181,5.5],
  "surat":[21.170,72.831,5.5], "kochi":[9.931,76.267,5.5], "cochin":[9.931,76.267,5.5],
  "coimbatore":[11.017,76.956,5.5], "thiruvananthapuram":[8.524,76.937,5.5], "trivandrum":[8.524,76.937,5.5],
  "mysuru":[12.295,76.639,5.5], "mysore":[12.295,76.639,5.5], "mangaluru":[12.914,74.856,5.5],
  "mangalore":[12.914,74.856,5.5], "hubballi":[15.365,75.124,5.5], "belagavi":[15.849,74.498,5.5],
  "vijayawada":[16.507,80.648,5.5], "visakhapatnam":[17.687,83.219,5.5], "vizag":[17.687,83.219,5.5],
  "tirupati":[13.629,79.419,5.5], "warangal":[17.978,79.594,5.5], "guntur":[16.306,80.436,5.5],
  "nellore":[14.442,79.986,5.5], "rajahmundry":[17.005,81.804,5.5], "kakinada":[16.989,82.247,5.5],
  "madurai":[9.925,78.120,5.5], "tiruchirappalli":[10.790,78.704,5.5], "trichy":[10.790,78.704,5.5],
  "salem":[11.664,78.146,5.5], "tirunelveli":[8.714,77.756,5.5], "vellore":[12.916,79.132,5.5],
  "erode":[11.342,77.727,5.5], "thrissur":[10.527,76.214,5.5], "kollam":[8.893,76.614,5.5],
  "kozhikode":[11.258,75.780,5.5], "calicut":[11.258,75.780,5.5], "kannur":[11.874,75.370,5.5],
  "alappuzha":[9.498,76.339,5.5], "palakkad":[10.786,76.655,5.5], "kottayam":[9.591,76.522,5.5],
  "chandigarh":[30.733,76.779,5.5], "ludhiana":[30.901,75.857,5.5], "amritsar":[31.634,74.873,5.5],
  "jalandhar":[31.326,75.576,5.5], "patiala":[30.339,76.386,5.5], "gurugram":[28.459,77.026,5.5],
  "gurgaon":[28.459,77.026,5.5], "noida":[28.535,77.391,5.5], "ghaziabad":[28.669,77.453,5.5],
  "faridabad":[28.408,77.317,5.5], "meerut":[28.984,77.706,5.5], "agra":[27.177,78.008,5.5],
  "varanasi":[25.317,82.973,5.5], "banaras":[25.317,82.973,5.5], "allahabad":[25.436,81.846,5.5],
  "prayagraj":[25.436,81.846,5.5], "gorakhpur":[26.760,83.373,5.5], "bareilly":[28.367,79.430,5.5],
  "aligarh":[27.897,78.088,5.5], "moradabad":[28.838,78.773,5.5], "jhansi":[25.448,78.569,5.5],
  "gwalior":[26.218,78.183,5.5], "jabalpur":[23.182,79.987,5.5], "ujjain":[23.176,75.789,5.5],
  "raipur":[21.251,81.629,5.5], "bilaspur":[22.080,82.156,5.5], "ranchi":[23.344,85.310,5.5],
  "jamshedpur":[22.804,86.203,5.5], "dhanbad":[23.796,86.430,5.5], "bhubaneswar":[20.296,85.825,5.5],
  "cuttack":[20.462,85.883,5.5], "rourkela":[22.260,84.854,5.5], "guwahati":[26.145,91.736,5.5],
  "silchar":[24.833,92.779,5.5], "dibrugarh":[27.472,94.912,5.5], "imphal":[24.817,93.937,5.5],
  "shillong":[25.578,91.893,5.5], "aizawl":[23.727,92.718,5.5], "agartala":[23.831,91.287,5.5],
  "kohima":[25.675,94.108,5.5], "gangtok":[27.331,88.614,5.5], "siliguri":[26.727,88.395,5.5],
  "durgapur":[23.520,87.311,5.5], "asansol":[23.685,86.975,5.5], "howrah":[22.595,88.264,5.5],
  "jodhpur":[26.238,73.024,5.5], "kota":[25.213,75.864,5.5], "bikaner":[28.022,73.311,5.5],
  "ajmer":[26.449,74.639,5.5], "udaipur":[24.585,73.712,5.5], "bhavnagar":[21.764,72.151,5.5],
  "rajkot":[22.303,70.802,5.5], "jamnagar":[22.470,70.058,5.5], "gandhinagar":[23.216,72.649,5.5],
  "nashik":[19.997,73.789,5.5], "aurangabad":[19.876,75.343,5.5], "solapur":[17.659,75.906,5.5],
  "kolhapur":[16.705,74.243,5.5], "amravati":[20.932,77.752,5.5], "nanded":[19.138,77.321,5.5],
  "thane":[19.218,72.978,5.5], "navi mumbai":[19.033,73.029,5.5], "panaji":[15.491,73.827,5.5],
  "goa":[15.491,73.827,5.5], "puducherry":[11.941,79.808,5.5], "pondicherry":[11.941,79.808,5.5],
  "dehradun":[30.317,78.032,5.5], "haridwar":[29.945,78.164,5.5], "rishikesh":[30.087,78.270,5.5],
  "nainital":[29.391,79.454,5.5], "shimla":[31.104,77.173,5.5], "srinagar":[34.084,74.797,5.5],
  "jammu":[32.726,74.857,5.5], "leh":[34.152,77.577,5.5], "kathmandu":[27.717,85.324,5.75],
  "colombo":[6.927,79.861,5.5], "dhaka":[23.811,90.413,6], "karachi":[24.861,67.010,5],
  "lahore":[31.520,74.359,5], "islamabad":[33.684,73.048,5], "dubai":[25.205,55.271,4],
  "abu dhabi":[24.453,54.377,4], "doha":[25.286,51.531,3], "riyadh":[24.713,46.675,3],
  "muscat":[23.588,58.408,4], "kuwait":[29.376,47.978,3], "manama":[26.229,50.586,3],
  "singapore":[1.352,103.820,8], "kuala lumpur":[3.139,101.687,8], "bangkok":[13.756,100.502,7],
  "hong kong":[22.320,114.174,8], "shanghai":[31.230,121.474,8], "tokyo":[35.677,139.650,9],
  "seoul":[37.567,126.978,9], "sydney":[-33.869,151.209,11], "melbourne":[-37.814,144.963,11],
  "perth":[-31.953,115.857,8], "auckland":[-36.849,174.763,12], "london":[51.507,-0.128,1],
  "manchester":[53.481,-2.243,1], "birmingham":[52.487,-1.890,1], "dublin":[53.350,-6.260,1],
  "paris":[48.857,2.352,2], "berlin":[52.520,13.405,2], "amsterdam":[52.370,4.895,2],
  "frankfurt":[50.110,8.682,2], "zurich":[47.377,8.542,2], "madrid":[40.417,-3.704,2],
  "barcelona":[41.385,2.173,2], "rome":[41.903,12.496,2], "milan":[45.464,9.190,2],
  "lisbon":[38.722,-9.139,1], "stockholm":[59.329,18.069,2], "oslo":[59.914,10.752,2],
  "copenhagen":[55.677,12.568,2], "helsinki":[60.170,24.938,3], "warsaw":[52.230,21.012,2],
  "moscow":[55.756,37.617,3], "istanbul":[41.008,28.978,3], "athens":[37.984,23.728,3],
  "new york":[40.713,-74.006,-5], "boston":[42.360,-71.059,-5], "toronto":[43.653,-79.383,-5],
  "chicago":[41.878,-87.630,-6], "austin":[30.267,-97.743,-6], "houston":[29.760,-95.370,-6],
  "denver":[39.739,-104.990,-7], "los angeles":[34.052,-118.244,-8], "san francisco":[37.775,-122.419,-8],
  "seattle":[47.606,-122.332,-8], "vancouver":[49.283,-123.121,-8], "san jose":[37.339,-121.895,-8],
  "mexico city":[19.433,-99.133,-6], "sao paulo":[-23.551,-46.633,-3], "buenos aires":[-34.604,-58.382,-3],
  "lagos":[6.524,3.379,1], "nairobi":[-1.286,36.817,3], "johannesburg":[-26.204,28.047,2],
  "cape town":[-33.925,18.424,2], "cairo":[30.044,31.236,2], "tehran":[35.689,51.389,3.5],
  "kabul":[34.556,69.208,4.5], "tashkent":[41.299,69.240,5], "almaty":[43.238,76.889,6]
};
function placeOf(name) {
  const k = String(name || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (CITIES[k]) return { lat: CITIES[k][0], lon: CITIES[k][1], tz: CITIES[k][2], known: true };
  const part = Object.keys(CITIES).find(c => k.includes(c));
  if (part) return { lat: CITIES[part][0], lon: CITIES[part][1], tz: CITIES[part][2], known: true };
  return { lat: 20.5937, lon: 78.9629, tz: 5.5, known: false };   // centre of India
}

/* ---------------- signs, nakshatras ---------------- */
const SIGNS = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
const SIGN_LORD = ['Mars','Venus','Mercury','Moon','Sun','Mercury','Venus','Mars','Jupiter','Saturn','Saturn','Jupiter'];
const ELEMENT = ['Fire','Earth','Air','Water'];
const MODALITY = ['Cardinal','Fixed','Mutable'];
const signOf = lon => Math.floor(norm360(lon) / 30);

const NAK = ['Ashwini','Bharani','Krittika','Rohini','Mrigashira','Ardra','Punarvasu','Pushya','Ashlesha','Magha','Purva Phalguni','Uttara Phalguni','Hasta','Chitra','Swati','Vishakha','Anuradha','Jyeshtha','Mula','Purva Ashadha','Uttara Ashadha','Shravana','Dhanishta','Shatabhisha','Purva Bhadrapada','Uttara Bhadrapada','Revati'];
const NAK_LORD = ['Ketu','Venus','Sun','Moon','Mars','Rahu','Jupiter','Saturn','Mercury','Ketu','Venus','Sun','Moon','Mars','Rahu','Jupiter','Saturn','Mercury','Ketu','Venus','Sun','Moon','Mars','Rahu','Jupiter','Saturn','Mercury'];
const nakshatraOf = sid => Math.floor(norm360(sid) / (360/27));
const padaOf = sid => Math.floor((norm360(sid) % (360/27)) / (360/108)) + 1;

/* ---------------- ashtakoota ---------------- */
const GANA = { Deva:['Ashwini','Mrigashira','Punarvasu','Pushya','Hasta','Swati','Anuradha','Shravana','Revati'],
  Manushya:['Bharani','Rohini','Ardra','Purva Phalguni','Uttara Phalguni','Purva Ashadha','Uttara Ashadha','Purva Bhadrapada','Uttara Bhadrapada'],
  Rakshasa:['Krittika','Ashlesha','Magha','Chitra','Vishakha','Jyeshtha','Mula','Dhanishta','Shatabhisha'] };
const NADI = { Adi:['Ashwini','Ardra','Punarvasu','Uttara Phalguni','Hasta','Jyeshtha','Mula','Shatabhisha','Purva Bhadrapada'],
  Madhya:['Bharani','Mrigashira','Pushya','Purva Phalguni','Chitra','Anuradha','Purva Ashadha','Dhanishta','Uttara Bhadrapada'],
  Antya:['Krittika','Rohini','Ashlesha','Magha','Swati','Vishakha','Uttara Ashadha','Shravana','Revati'] };
const YONI = ['Horse','Elephant','Sheep','Serpent','Serpent','Dog','Cat','Sheep','Cat','Rat','Rat','Cow','Buffalo','Tiger','Buffalo','Tiger','Deer','Deer','Dog','Monkey','Mongoose','Monkey','Lion','Horse','Lion','Cow','Elephant'];
const YONI_ENEMY = [['Horse','Buffalo'],['Elephant','Lion'],['Sheep','Monkey'],['Serpent','Mongoose'],['Dog','Deer'],['Cat','Rat'],['Cow','Tiger']];
const VASHYA = ['chatushpad','chatushpad','manav','jalachar','vanachar','manav','manav','keeta','manav','jalachar','manav','jalachar'];
const VARNA = ['Kshatriya','Vaishya','Shudra','Brahmin','Kshatriya','Vaishya','Shudra','Brahmin','Kshatriya','Vaishya','Shudra','Brahmin'];
const VARNA_RANK = { Brahmin:4, Kshatriya:3, Vaishya:2, Shudra:1 };
const LORD_FRIENDS = {
  Sun:{f:['Moon','Mars','Jupiter'], n:['Mercury'], e:['Venus','Saturn']},
  Moon:{f:['Sun','Mercury'], n:['Mars','Jupiter','Venus','Saturn'], e:[]},
  Mars:{f:['Sun','Moon','Jupiter'], n:['Venus','Saturn'], e:['Mercury']},
  Mercury:{f:['Sun','Venus'], n:['Mars','Jupiter','Saturn'], e:['Moon']},
  Jupiter:{f:['Sun','Moon','Mars'], n:['Saturn'], e:['Mercury','Venus']},
  Venus:{f:['Mercury','Saturn'], n:['Mars','Jupiter'], e:['Sun','Moon']},
  Saturn:{f:['Mercury','Venus'], n:['Jupiter'], e:['Sun','Moon','Mars']}
};
const rel = (a, b) => a === b ? 'f' : (LORD_FRIENDS[a].f.includes(b) ? 'f' : (LORD_FRIENDS[a].e.includes(b) ? 'e' : 'n'));

function ashtakoota(a, b) {           // a = male chart, b = female chart (by convention)
  const out = {};
  out.Varna = VARNA_RANK[VARNA[a.rashi]] >= VARNA_RANK[VARNA[b.rashi]] ? 1 : 0;
  const wa = VASHYA[a.rashi], wb = VASHYA[b.rashi];
  out.Vashya = wa === wb ? 2 : (wa === 'vanachar' || wb === 'vanachar') ? 0.5
    : ((wa === 'keeta' && wb === 'vanachar') || (wb === 'keeta' && wa === 'vanachar')) ? 0
    : ((wa === 'manav' && wb === 'jalachar') || (wb === 'manav' && wa === 'jalachar')) ? 1.5 : 1;
  const tara = (from, to) => { const c = ((to - from + 27) % 27) + 1; return [3,5,7].includes(c % 9) ? 0 : 1.5; };
  out.Tara = tara(b.nak, a.nak) + tara(a.nak, b.nak);
  const ya = YONI[a.nak], yb = YONI[b.nak];
  out.Yoni = ya === yb ? 4 : (YONI_ENEMY.some(([x, y]) => (x === ya && y === yb) || (x === yb && y === ya)) ? 0 : 2);
  const la = SIGN_LORD[a.rashi], lb = SIGN_LORD[b.rashi];
  if (la === lb) out['Graha Maitri'] = 5;
  else {
    const pair = [rel(la, lb), rel(lb, la)].sort().join('');
    out['Graha Maitri'] = pair === 'ff' ? 5 : pair === 'fn' ? 4 : pair === 'nn' ? 3 : pair === 'ef' ? 1 : pair === 'en' ? 0.5 : 0;
  }
  const ga = Object.keys(GANA).find(k => GANA[k].includes(NAK[a.nak]));
  const gb = Object.keys(GANA).find(k => GANA[k].includes(NAK[b.nak]));
  out.Gana = ga === gb ? 6 : (new Set([ga, gb]).has('Rakshasa') ? (new Set([ga, gb]).has('Deva') ? 1 : 0) : 5);
  const d1 = ((a.rashi - b.rashi + 12) % 12) + 1, d2 = ((b.rashi - a.rashi + 12) % 12) + 1;
  out.Bhakoot = ['2-12','5-9','6-8'].includes([d1, d2].sort((x, y) => x - y).join('-')) ? 0 : 7;
  const na = Object.keys(NADI).find(k => NADI[k].includes(NAK[a.nak]));
  const nb = Object.keys(NADI).find(k => NADI[k].includes(NAK[b.nak]));
  out.Nadi = na === nb ? 0 : 8;
  const max = { Varna:1, Vashya:2, Tara:3, Yoni:4, 'Graha Maitri':5, Gana:6, Bhakoot:7, Nadi:8 };
  const total = Object.keys(max).reduce((s, k) => s + out[k], 0);
  return { kootas: out, max, total, pct: total / 36 };
}

/* ---------------- numerology ---------------- */
const reduce = n => { while (n > 9) n = String(n).split('').reduce((a, d) => a + (+d), 0); return n; };
const PLANET_OF = {1:'Sun',2:'Moon',3:'Jupiter',4:'Rahu',5:'Mercury',6:'Venus',7:'Ketu',8:'Saturn',9:'Mars'};
const NUM_FRIENDS = {
  1:{f:[1,2,3,5,9], e:[8]}, 2:{f:[1,2,5], e:[4,7]}, 3:{f:[1,2,3,9], e:[5,6]},
  4:{f:[4,5,6,8], e:[1,2,9]}, 5:{f:[1,3,5,6], e:[2]}, 6:{f:[4,5,6,8], e:[1,2]},
  7:{f:[4,6,7,8], e:[1,2]}, 8:{f:[4,5,6,7,8], e:[1,2,9]}, 9:{f:[1,2,3,9], e:[5]}
};
const LETTER_NUM = { a:1,i:1,j:1,q:1,y:1, b:2,k:2,r:2, c:3,g:3,l:3,s:3, d:4,m:4,t:4,
  e:5,h:5,n:5,x:5, u:6,v:6,w:6, o:7,z:7, f:8,p:8 };
function numerology(dob, name) {
  const [y, m, d] = dob.split('-').map(Number);
  const mulank = reduce(d);
  const bhagyank = reduce(String(d) + String(m) + String(y));
  const clean = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  const namank = clean ? reduce([...clean].reduce((s, ch) => s + (LETTER_NUM[ch] || 0), 0)) : null;
  const digits = String(d) + String(m) + String(y);
  const counts = {};
  for (let i = 1; i <= 9; i++) counts[i] = digits.split('').filter(x => x === String(i)).length;
  return { mulank, bhagyank, namank, counts };
}
function numPair(x, y) {
  const f = (a, b) => a === b ? 2 : (NUM_FRIENDS[a].f.includes(b) && NUM_FRIENDS[b].f.includes(a)) ? 2
    : (NUM_FRIENDS[a].e.includes(b) && NUM_FRIENDS[b].e.includes(a)) ? 0
    : (NUM_FRIENDS[a].f.includes(b) || NUM_FRIENDS[b].f.includes(a)) ? 1 : 1;
  const pct = (a, b) => { const r = f(a, b); return r === 2 ? 1 : r === 1 ? 0.65 : 0.25; };
  return pct(x, y);
}

/* ---------------- Chinese ---------------- */
const ANIMALS = ['Rat','Ox','Tiger','Rabbit','Dragon','Snake','Horse','Goat','Monkey','Rooster','Dog','Pig'];
const ELEMENTS_CN = ['Wood','Fire','Earth','Metal','Water'];
const TRINES = [['Rat','Dragon','Monkey'],['Ox','Snake','Rooster'],['Tiger','Horse','Dog'],['Rabbit','Goat','Pig']];
const CLASH = { Rat:'Horse', Ox:'Goat', Tiger:'Monkey', Rabbit:'Rooster', Dragon:'Dog', Snake:'Pig', Horse:'Rat', Goat:'Ox', Monkey:'Tiger', Rooster:'Rabbit', Dog:'Dragon', Pig:'Snake' };
function chineseOn(dob, bornAfterCNY) {
  const y = Number(dob.slice(0, 4));
  const year = bornAfterCNY ? y : y - 1;
  const idx = ((year - 4) % 12 + 12) % 12;
  return {
    animal: ANIMALS[idx],
    element: ELEMENTS_CN[Math.floor((((year - 4) % 10) + 10) % 10 / 2)],
    inner: ANIMALS[((year - 4) % 12 + 12) % 12]
  };
}
function chinesePair(a, b) {
  if (a.animal === b.animal) return 0.8;
  if (TRINES.some(t => t.includes(a.animal) && t.includes(b.animal))) return 1;
  if (CLASH[a.animal] === b.animal) return 0.15;
  if (a.element === b.element) return 0.7;
  return 0.55;
}


/* ---------------- sidereal time & ascendant ---------------- */
function gmst(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  return norm360(280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - T * T * T / 38710000);
}
function obliquity(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  return 23.439291 - 0.0130042 * T;
}
/** tropical ascendant in degrees, from latitude and local sidereal time */
function ascendant(jd, lat, lon) {
  const lst = norm360(gmst(jd) + lon) * D2R;
  const eps = obliquity(jd) * D2R;
  const phi = lat * D2R;
  const y = Math.cos(lst);
  const x = -(Math.sin(lst) * Math.cos(eps) + Math.tan(phi) * Math.sin(eps));
  return norm360(Math.atan2(y, x) * R2D);
}
/** mean lunar node (Rahu), retrograde through the zodiac */
function rahu(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  return norm360(125.0445479 - 1934.1362891 * T + 0.0020754 * T * T + T * T * T / 467441);
}
const MANGLIK_HOUSES = [1, 2, 4, 7, 8, 12];
/** whole-sign houses counted from the ascendant */
function houseOf(lon, ascLon) {
  return ((Math.floor(norm360(lon) / 30) - Math.floor(norm360(ascLon) / 30) + 12) % 12) + 1;
}


/* ---------------- more zodiac systems ---------------- */
/** the moment the Moon and Sun share a longitude — found by bisection on the
 *  already-validated lunar series, so it agrees with the rest of the engine */
function newMoonNear(jdGuess) {
  const elong = jd => norm360(moonLongitude(jd) - sunLongitude(jd));
  let a = jdGuess - 3, b = jdGuess + 3;
  let ea = elong(a) - 360, eb = elong(b);          // unwrap around 0
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2;
    const em = (() => { const e = elong(m); return e > 180 ? e - 360 : e; })();
    if (em < 0) a = m; else b = m;
  }
  return (a + b) / 2;
}
/** Chinese New Year: the new moon falling between 21 Jan and 21 Feb */
function chineseNewYear(year) {
  let jd = julianDay(year, 1, 20, 0);
  for (let i = 0; i < 3; i++) {
    const nm = newMoonNear(jd + i * 29.53);
    const d = new Date((nm - 2440587.5) * 86400000);
    const m = d.getUTCMonth() + 1, day = d.getUTCDate();
    if ((m === 1 && day >= 21) || (m === 2 && day <= 21)) return nm;
  }
  return julianDay(year, 2, 4, 0);
}
const MAYAN = ['Imix','Ik','Akbal','Kan','Chicchan','Cimi','Manik','Lamat','Muluc','Oc','Chuen','Eb','Ben','Ix','Men','Cib','Caban','Etznab','Cauac','Ahau'];
const AZTEC = ['Cipactli','Ehecatl','Calli','Cuetzpalin','Coatl','Miquiztli','Mazatl','Tochtli','Atl','Itzcuintli','Ozomahtli','Malinalli','Acatl','Ocelotl','Cuauhtli','Cozcacuauhtli','Ollin','Tecpatl','Quiahuitl','Xochitl'];
function tzolkin(jd) {
  const jdn = Math.floor(jd + 0.5);
  const n = ((jdn - 584283) % 260 + 260) % 260;      // GMT correlation
  return { mayan: MAYAN[n % 20], aztec: AZTEC[n % 20], tone: (n % 13) + 1, number: n + 1 };
}
const CELTIC = [
  ['Birch', 12, 24, 1, 20], ['Rowan', 1, 21, 2, 17], ['Ash', 2, 18, 3, 17], ['Alder', 3, 18, 4, 14],
  ['Willow', 4, 15, 5, 12], ['Hawthorn', 5, 13, 6, 9], ['Oak', 6, 10, 7, 7], ['Holly', 7, 8, 8, 4],
  ['Hazel', 8, 5, 9, 1], ['Vine', 9, 2, 9, 29], ['Ivy', 9, 30, 10, 27], ['Reed', 10, 28, 11, 24],
  ['Elder', 11, 25, 12, 23]
];
function celtic(dob) {
  const [y, m, d] = dob.split('-').map(Number);
  const v = m * 100 + d;
  for (const [name, m1, d1, m2, d2] of CELTIC) {
    const a = m1 * 100 + d1, b = m2 * 100 + d2;
    if (a <= b ? (v >= a && v <= b) : (v >= a || v <= b)) return name;
  }
  return 'Birch';
}
const BURMESE = ['Garuda','Tiger','Lion','Elephant with tusks','Elephant without tusks','Rat','Guinea pig','Dragon'];
function burmese(dob, tob) {
  const [y, m, d] = dob.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();     // 0 = Sunday
  const pm = tob && Number(tob.split(':')[0]) >= 12;
  if (wd === 3) return pm ? BURMESE[4] : BURMESE[3];          // Wednesday splits
  return wd < 3 ? BURMESE[wd] : BURMESE[wd + 1];
}
/** the 13 astronomical constellations the Sun actually passes through */
const THIRTEEN = [[28,'Aries'],[53,'Taurus'],[91,'Gemini'],[119,'Cancer'],[139,'Leo'],[175,'Virgo'],
  [218,'Libra'],[242,'Scorpio'],[248,'Ophiuchus'],[266,'Sagittarius'],[301,'Capricorn'],[328,'Aquarius'],[352,'Pisces']];
function thirteenSign(tropicalLon) {
  const L = norm360(tropicalLon);
  let out = THIRTEEN[THIRTEEN.length - 1][1];
  for (const [start, name] of THIRTEEN) if (L >= start) out = name;
  return out;
}

/* ---------------- one person's whole chart ---------------- */
function chart({ dob, tob, name, place, lat, lon }) {
  const hasTime = !!tob;
  const p = (lat != null && lon != null) ? { lat, lon, tz: 5.5, known: true } : placeOf(place);
  const jd = jdFromLocal(dob, tob || '12:00', p.tz);
  const ay = lahiriAyanamsa(jd);
  const sid = lon => norm360(lon - ay);

  const sunSid = sid(sunLongitude(jd));
  const moonSid = sid(moonLongitude(jd));
  const venusSid = sid(geoLongitude('venus', jd));
  const marsSid = sid(geoLongitude('mars', jd));
  const rahuSid = sid(rahu(jd));
  const ketuSid = norm360(rahuSid + 180);
  const ascSid = sid(ascendant(jd, p.lat, p.lon));

  const nak = nakshatraOf(moonSid);
  const swing = hasTime ? 0 : 0.55 * 13.176;
  const nakLow = nakshatraOf(moonSid - swing), nakHigh = nakshatraOf(moonSid + swing);

  const marsHouseLagna = houseOf(marsSid, ascSid);
  const marsHouseMoon = houseOf(marsSid, moonSid);
  const manglikFromLagna = MANGLIK_HOUSES.includes(marsHouseLagna);
  const manglikFromMoon = MANGLIK_HOUSES.includes(marsHouseMoon);

  const cnJD = chineseNewYear(new Date(Date.UTC(+dob.slice(0, 4), +dob.slice(5, 7) - 1, +dob.slice(8, 10))).getUTCFullYear());
  const bornAfterCNY = jd >= cnJD;

  return {
    dob, tob: tob || '',
    hasTime,
    western: {
      sun: SIGNS[signOf(sunLongitude(jd))],
      moon: SIGNS[signOf(moonLongitude(jd))],
      lagna: SIGNS[signOf(ascendant(jd, p.lat, p.lon))],
      venus: SIGNS[signOf(geoLongitude('venus', jd))],
      mars: SIGNS[signOf(geoLongitude('mars', jd))]
    },
    systems: {
      mayan: tzolkin(jd),
      celtic: celtic(dob),
      burmese: burmese(dob, tob),
      thirteen: thirteenSign(sunLongitude(jd)),
      chineseYearStart: bornAfterCNY
    },
    place: { known: p.known, lat: p.lat, lon: p.lon, tz: p.tz, name: place || '' },
    sun: { sign: SIGNS[signOf(sunSid)], lon: sunSid, house: houseOf(sunSid, ascSid) },
    moon: { sign: SIGNS[signOf(moonSid)], lon: moonSid, house: houseOf(moonSid, ascSid),
            nak: NAK[nak], nakIndex: nak, pada: padaOf(moonSid), lord: NAK_LORD[nak],
            nakRange: hasTime ? [NAK[nak]] : [...new Set([NAK[nakLow], NAK[nak], NAK[nakHigh]])] },
    venus: { sign: SIGNS[signOf(venusSid)], house: houseOf(venusSid, ascSid) },
    mars: { sign: SIGNS[signOf(marsSid)], house: marsHouseLagna, houseFromMoon: marsHouseMoon },
    rahu: { sign: SIGNS[signOf(rahuSid)], house: houseOf(rahuSid, ascSid) },
    ketu: { sign: SIGNS[signOf(ketuSid)], house: houseOf(ketuSid, ascSid) },
    lagna: { sign: SIGNS[signOf(ascSid)], lon: ascSid, lord: SIGN_LORD[signOf(ascSid)] },
    manglik: { fromLagna: manglikFromLagna, fromMoon: manglikFromMoon, is: manglikFromLagna || manglikFromMoon,
               note: !hasTime ? 'birth time missing — Mars house is a guess' : (p.known ? '' : 'birth place not recognised — lagna may be off') },
    rashi: signOf(moonSid),
    element: ELEMENT[signOf(sunSid) % 4],
    modality: MODALITY[signOf(sunSid) % 3],
    numerology: numerology(dob, name),
    chinese: chineseOn(dob, bornAfterCNY),
    ayanamsa: ay
  };
}


  return { chart, ashtakoota, placeOf, CITIES, tzolkin, celtic, burmese, thirteenSign, chineseNewYear, numerology, numPair, chineseOn, chinesePair, julianDay, jdFromLocal, moonLongitude, sunLongitude, geoLongitude, SIGNS, NAK, SIGN_LORD, ELEMENT, MODALITY, PLANET_OF, ANIMALS, ELEMENTS_CN };
})();


const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRESENCE_MS = 25_000;
/* how many different people must report someone before the account suspends
   itself pending a human look. Three is low enough to catch a problem early
   and high enough that one annoyed person cannot do it alone. */
const REPORT_SUSPEND_AT = 3;
const VERSION = 'v12';

/* ---------- India place index: 7k towns with real coordinates ---------- */
let PLACES = [];
try { PLACES = JSON.parse(fs.readFileSync(path.join(__dirname, 'geo.json'), 'utf8')); }
catch { console.error('geo.json missing — place lookup will fail'); }
const placeIndex = new Map(PLACES.map(r => [String(r[0]).toLowerCase(), { name: r[0], state: r[1], lat: r[2], lon: r[3] }]));
function lookupPlace(input) {
  const k = String(input || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  if (!k) return null;
  if (placeIndex.has(k)) return placeIndex.get(k);
  const first = k.split(',')[0].trim();
  return placeIndex.get(first) || null;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = makeStore({ dataDir: DATA_DIR, connectionString: process.env.DATABASE_URL });

/* ================================================================== *
 * storage
 * ================================================================== */
const blank = () => ({ users: {}, tokens: {}, chats: {}, queue: [], reports: [], seq: 1 });
let db = blank();
let saveTimer = null, lastSaveError = null;

/* debounced write-through: mutations stay synchronous in the request path */
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try { await store.save(db); lastSaveError = null; }
    catch (e) { lastSaveError = e.message; console.error('save failed:', e.message); }
  }, 250);
}
async function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { await store.save(db); } catch (e) { console.error('flush failed:', e.message); }
}
async function initStore() {
  const loaded = await store.init();
  if (loaded) db = Object.assign(blank(), loaded);
  return store.kind;
}

/* ---------- mail ---------- */
async function sendMail(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`\n[mail:dev] to=${to}\n  ${subject}\n  ${text.replace(/\n/g, '\n  ')}\n`);
    return { dev: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ from: process.env.MAIL_FROM || 'Milao <onboarding@resend.dev>', to: [to], subject, text })
  });
  if (!res.ok) throw new Error('mail rejected: ' + (await res.text()).slice(0, 160));
  return { ok: true };
}
const sixDigits = () => String(Math.floor(100000 + Math.random() * 900000));
const uid = () => crypto.randomBytes(9).toString('hex');
const now = () => Date.now();

/* ================================================================== *
 * passwords
 * ================================================================== */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const makePw = pw => { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: hashPw(pw, salt) }; };
const checkPw = (u, pw) => {
  const h = hashPw(pw, u.salt);
  return h.length === u.hash.length && crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.hash, 'hex'));
};

/* ================================================================== *
 * tests — all short, all server-scored
 * ================================================================== */
const SCALE = ['Not me', 'A little', 'Somewhat', 'Quite', 'Exactly'];

const TESTS = {
  big5: {
    title: 'Big Five', blurb: 'Twenty statements. The backbone of the score — the model psychologists actually use.',
    kind: 'scale', weight: 25,
    items: [
      { id:'o1', dim:'O', text:'I look for the strange option on a menu.' },
      { id:'o2', dim:'O', text:'Routine bores me faster than it bores most people.' },
      { id:'o3', dim:'O', text:'I would rather improvise a trip than plan it.' },
      { id:'o4', dim:'O', text:'I lose track of time in a gallery or a bookshop.' },
      { id:'c1', dim:'C', text:'I finish the things I start.' },
      { id:'c2', dim:'C', text:'People rely on me to be on time.' },
      { id:'c3', dim:'C', text:'I keep a list somewhere, always.' },
      { id:'c4', dim:'C', text:'I leave packing for the last hour.', rev:true },
      { id:'e1', dim:'E', text:'I start conversations with strangers.' },
      { id:'e2', dim:'E', text:'A party leaves me more energised than tired.' },
      { id:'e3', dim:'E', text:'I would rather text than call.', rev:true },
      { id:'e4', dim:'E', text:'I think out loud, mostly.' },
      { id:'a1', dim:'A', text:'I would rather adjust than win the argument.' },
      { id:'a2', dim:'A', text:'I notice who has been left out of the group.' },
      { id:'a3', dim:'A', text:'I say the hard thing even when it costs me.', rev:true },
      { id:'a4', dim:'A', text:'I forgive quickly.' },
      { id:'n1', dim:'N', text:'I replay awkward moments for days.', rev:true },
      { id:'n2', dim:'N', text:'A small setback can derail my whole day.', rev:true },
      { id:'n3', dim:'N', text:'I stay calm when plans collapse.' },
      { id:'n4', dim:'N', text:'I worry about things before they happen.', rev:true }
    ]
  },
  type: {
    title: 'Type indicator', blurb: 'Eight either-ors on the four Jungian axes. Not MBTI — that is trademarked.',
    kind: 'choice', weight: 8,
    items: [
      { id:'t1', axis:'EI', text:'At a party you…', options:[{label:'Work the room',v:1},{label:'Find one person and stay',v:0}] },
      { id:'t2', axis:'EI', text:'You think…', options:[{label:'Out loud, with company',v:1},{label:'In your head, first',v:0}] },
      { id:'t3', axis:'SN', text:'You trust…', options:[{label:'What you can verify',v:0},{label:'The pattern you sense',v:1}] },
      { id:'t4', axis:'SN', text:'Instructions, ideally…', options:[{label:'Step by step',v:0},{label:'The big picture',v:1}] },
      { id:'t5', axis:'TF', text:'Decisions start with…', options:[{label:'What is logical',v:1},{label:'Who it affects',v:0}] },
      { id:'t6', axis:'TF', text:'Feedback should be…', options:[{label:'Direct',v:1},{label:'Gentle',v:0}] },
      { id:'t7', axis:'JP', text:'Trips should be…', options:[{label:'Planned',v:1},{label:'Improvised',v:0}] },
      { id:'t8', axis:'JP', text:'Deadlines get met…', options:[{label:'Early',v:1},{label:'In the last hour',v:0}] }
    ]
  },
  attach: {
    title: 'Attachment style', blurb: 'Twelve statements about closeness. The single best predictor of how a relationship goes.',
    kind: 'scale', weight: 22,
    items: [
      { id:'an1', dim:'anx', text:'I worry that people I love will leave.' },
      { id:'an2', dim:'anx', text:'I need more reassurance than I admit.' },
      { id:'an3', dim:'anx', text:'Silence from someone I care about makes me panic.' },
      { id:'an4', dim:'anx', text:'I am comfortable on my own.', rev:true },
      { id:'an5', dim:'anx', text:'I check whether they have read the message.' },
      { id:'an6', dim:'anx', text:'I notice small changes in how someone talks to me.' },
      { id:'av1', dim:'avo', text:'I would rather solve it alone than ask for help.' },
      { id:'av2', dim:'avo', text:'Getting too close makes me want space.' },
      { id:'av3', dim:'avo', text:'I keep parts of myself back.' },
      { id:'av4', dim:'avo', text:'Talking about feelings is easy for me.', rev:true },
      { id:'av5', dim:'avo', text:'I pull away when someone starts depending on me.' },
      { id:'av6', dim:'avo', text:'I would rather not need anyone.', rev:true }
    ]
  },
  enneagram: {
    title: 'Enneagram', blurb: 'Eighteen statements, two for each of the nine types. Rate how much each one is you.',
    kind: 'scale', weight: 15,
    items: [
      { id:'e1a', dim:'1', text:'I notice what is wrong with things before what is right.' },
      { id:'e1b', dim:'1', text:'I hold myself to a standard I would not ask of anyone else.' },
      { id:'e2a', dim:'2', text:'I can tell what people need before they say it.' },
      { id:'e2b', dim:'2', text:'I feel responsible for other people being okay.' },
      { id:'e3a', dim:'3', text:'I want to be seen doing well.' },
      { id:'e3b', dim:'3', text:'I measure myself by what I have achieved.' },
      { id:'e4a', dim:'4', text:'I feel things differently from most people.' },
      { id:'e4b', dim:'4', text:'I would rather be unusual than comfortable.' },
      { id:'e5a', dim:'5', text:'I need long stretches alone to think.' },
      { id:'e5b', dim:'5', text:'I would rather understand a thing than join in.' },
      { id:'e6a', dim:'6', text:'I am usually the one asking what could go wrong.' },
      { id:'e6b', dim:'6', text:'I trust people slowly and then completely.' },
      { id:'e7a', dim:'7', text:'I say yes to plans before checking my calendar.' },
      { id:'e7b', dim:'7', text:'I would rather keep my options open than commit.' },
      { id:'e8a', dim:'8', text:'I would rather be in charge than be surprised.' },
      { id:'e8b', dim:'8', text:'I say the thing everyone is avoiding.' },
      { id:'e9a', dim:'9', text:'I would rather keep the peace than be right.' },
      { id:'e9b', dim:'9', text:'I lose track of what I want when others want something.' }
    ]
  },
  conflict: {
    title: 'Conflict style', blurb: 'Eight situations. What you actually do when it goes wrong.',
    kind: 'choice', weight: 10,
    items: [
      { id:'k1', text:'In a fight you…', options:[{label:'Push to win',v:'Competing'},{label:'Find the middle',v:'Compromising'},{label:'Go quiet',v:'Avoiding'},{label:'Give in',v:'Accommodating'},{label:'Fix the actual problem',v:'Collaborating'}] },
      { id:'k2', text:'Someone is wrong and angry. You…', options:[{label:'Correct them',v:'Competing'},{label:'Split it',v:'Compromising'},{label:'Leave the room',v:'Avoiding'},{label:'Absorb it',v:'Accommodating'},{label:'Ask what they need',v:'Collaborating'}] },
      { id:'k3', text:'Unspoken tension is…', options:[{label:'Something to settle now',v:'Competing'},{label:'Something to manage',v:'Compromising'},{label:'Better left alone',v:'Avoiding'},{label:'Your fault somehow',v:'Accommodating'},{label:'Worth naming',v:'Collaborating'}] },
      { id:'k4', text:'You apologise…', options:[{label:'Rarely, when right',v:'Competing'},{label:'To end it',v:'Compromising'},{label:'By disappearing',v:'Avoiding'},{label:'Immediately',v:'Accommodating'},{label:'With what you understood',v:'Collaborating'}] },
      { id:'k5', text:'Best outcome of a fight?', options:[{label:'You were right',v:'Competing'},{label:'Both gave something',v:'Compromising'},{label:'It blew over',v:'Avoiding'},{label:'They are okay',v:'Accommodating'},{label:'Something changed',v:'Collaborating'}] },
      { id:'k6', text:'Long silence after a fight means…', options:[{label:'They should come to you',v:'Competing'},{label:'Cooling off',v:'Compromising'},{label:'Relief',v:'Avoiding'},{label:'You should fix it',v:'Accommodating'},{label:'Time to talk properly',v:'Collaborating'}] },
      { id:'k7', text:'You are blamed for something unfair.', options:[{label:'Defend yourself fully',v:'Competing'},{label:'Negotiate',v:'Compromising'},{label:'Say nothing',v:'Avoiding'},{label:'Apologise anyway',v:'Accommodating'},{label:'Get to the facts together',v:'Collaborating'}] },
      { id:'k8', text:'After a bad argument you want…', options:[{label:'The last word',v:'Competing'},{label:'A deal',v:'Compromising'},{label:'Distance',v:'Avoiding'},{label:'Peace, at any cost',v:'Accommodating'},{label:'Repair',v:'Collaborating'}] }
    ]
  }
};
const TEST_ORDER = ['big5', 'attach', 'enneagram', 'conflict', 'type'];

const publicTests = () => TEST_ORDER.map(id => {
  const t = TESTS[id];
  return {
    id, title: t.title, blurb: t.blurb, kind: t.kind, weight: t.weight, count: t.items.length,
    scale: t.kind === 'scale' ? SCALE : null,
    items: t.items.map(it => ({ id: it.id, text: it.text, options: (it.options || []).map(o => (typeof o === 'string' ? o : o.label)) }))
  };
});

/* ---------------- scoring ---------------- */
const c01 = v => Math.max(0, Math.min(1, v));

function scoreTest(id, answers) {
  const t = TESTS[id];
  if (!t) throw new Error('unknown test');

  if (id === 'big5' || id === 'attach' || id === 'enneagram') {
    const acc = {};
    for (const it of t.items) {
      let v = Number(answers[it.id]);
      if (!(v >= 1 && v <= 5)) throw new Error('missing: ' + it.id);
      if (it.rev) v = 6 - v;
      (acc[it.dim] = acc[it.dim] || []).push(v);
    }
    const dims = {};
    for (const k of Object.keys(acc)) dims[k] = c01((acc[k].reduce((a, b) => a + b, 0) / acc[k].length - 1) / 4);
    if (id === 'attach') {
      const { anx, avo } = dims;
      return { dims, summary: { style: anx >= .55 && avo >= .55 ? 'fearful' : anx >= .55 ? 'anxious' : avo >= .55 ? 'avoidant' : 'secure' } };
    }
    if (id === 'enneagram') {
      const best = Object.entries(dims).sort((a, b) => b[1] - a[1])[0];
      return { dims, summary: { ennea: Number(best[0]), scores: dims } };
    }
    return { dims, summary: {} };
  }

  if (id === 'type') {
    const ax = { EI: [], SN: [], TF: [], JP: [] };
    for (const it of t.items) {
      const a = Number(answers[it.id]);
      if (!(a >= 0)) throw new Error('missing: ' + it.id);
      ax[it.axis].push(it.options[a].v);
    }
    const f = k => ax[k].reduce((a, b) => a + b, 0) / ax[k].length;
    const e = f('EI'), s = f('SN'), tf = f('TF'), j = f('JP');
    return {
      dims: { e_i: e, s_n: s, t_f: tf, j_p: j },
      summary: { type: (e >= .5 ? 'E' : 'I') + (s >= .5 ? 'N' : 'S') + (tf >= .5 ? 'T' : 'F') + (j >= .5 ? 'J' : 'P') }
    };
  }

  if (id === 'love') {
    const a = Number(answers.love);
    if (!(a >= 0 && a < t.items[0].options.length)) throw new Error('missing: love');
    return { dims: {}, summary: { love: ['Words','Time','Acts','Gifts','Touch'][a] } };
  }

  if (id === 'disc' || id === 'humour' || id === 'conflict') {
    const tally = {};
    for (const it of t.items) {
      const a = Number(answers[it.id]);
      if (!(a >= 0)) throw new Error('missing: ' + it.id);
      const v = it.options[a].v;
      tally[v] = (tally[v] || 0) + 1;
    }
    const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
    return { dims: {}, summary: { [id === 'disc' ? 'disc' : id === 'humour' ? 'humour' : 'conflict']: best, tally } };
  }

  if (id === 'chrono') {
    let s = 0;
    t.items.forEach(it => {
      const a = Number(answers[it.id]);
      if (!(a >= 0)) throw new Error('missing: ' + it.id);
      s += a;
    });
    return { dims: {}, summary: { chrono: s <= 1 ? 'Lark' : s <= 3 ? 'Third bird' : 'Owl' } };
  }
  throw new Error('unknown test');
}

/* ================================================================== *
 * cibil (activity + completeness), tiers, slots
 * ================================================================== */
const TIERS = [
  { name: 'Bronze', min: 0, slots: 3 },
  { name: 'Silver', min: 600, slots: 5 },
  { name: 'Gold', min: 700, slots: 7 },
  { name: 'Platinum', min: 800, slots: 10 }
];
const tierOf = score => [...TIERS].reverse().find(t => score >= t.min);
/* activity moves the score in fractions, not points — consistency is what counts */
const EVENTS = { message: 0.02, reply: 0.05, fastReply: 0.05, longChat: 0.2,
                 leave: -0.1, skip: -0.3, skipped: +0.1, reported: -1 };

function completeness(u) {
  const done = Object.keys(u.results || {}).length;
  return Math.min(1, done / TEST_ORDER.length) * 100 + (u.tob ? 100 : 0);
}
/* consistency, not volume: how often you answer, how often a chat goes somewhere,
   and how long you have been around. Talking a lot gains you almost nothing. */
function consistency(u) {
  const st = u.stats || {};
  // no track record yet means no credit — a new account starts at the base
  const replyRate = st.received ? Math.min(1, (st.replies || 0) / st.received) : 0;
  const chats = st.chats || 0;
  const completion = chats ? Math.min(1, (st.completed || 0) / chats) : 0;
  const days = Math.max(0, (now() - (u.createdAt || now())) / 86400000);
  const tenure = Math.min(1, days / 30);
  return Math.round(120 * (0.45 * replyRate + 0.35 * completion + 0.20 * tenure));
}
function penalty(u) {
  const st = u.stats || {};
  return Math.min(40, Math.round((st.skips || 0) * 2 + (st.reported || 0) * 8));
}
function cibilOf(u) {
  const base = 300 + Math.round(completeness(u)) + consistency(u) - penalty(u);
  return Math.max(300, Math.min(900, Math.round(base + (u.cibilAdj || 0))));
}
const slotsOf = u => tierOf(cibilOf(u)).slots;
const activeChats = uid_ => Object.values(db.chats).filter(c => !c.endedAt && (c.a.uid === uid_ || c.b.uid === uid_));
const freeSlots = u => Math.max(0, slotsOf(u) - activeChats(u.id).length);
function bump(u, kind, n = 1) {
  u.cibilAdj = (u.cibilAdj || 0) + (EVENTS[kind] || 0) * n;
}

/* ================================================================== *
 * the pair score — every parameter, averaged over what both have
 * ================================================================== */
const ELEM_OK = { Fire:['Fire','Air'], Air:['Air','Fire'], Earth:['Earth','Water'], Water:['Water','Earth'] };
const signElem = i => astro.ELEMENT[i % 4];
const signMod = i => astro.MODALITY[i % 3];
const signIdx = name => astro.SIGNS.indexOf(name);

function signPair(aName, bName) {
  const a = signIdx(aName), b = signIdx(bName);
  if (a === b) return 1;
  if (signElem(a) === signElem(b)) return 0.85;
  if (ELEM_OK[signElem(a)].includes(signElem(b))) return 0.9;
  if (signMod(a) === signMod(b)) return 0.45;
  return 0.3;
}
function nakPair(a, b) {
  if (a.moon.nak === b.moon.nak) return 1;
  if (a.rashi === b.rashi) return 0.85;
  const d = Math.abs(a.rashi - b.rashi);
  if (d === 4 || d === 8) return 0.75;                 // trine
  return 0.5;
}

/* Rajju and Vedha — the two South Indian rules families actually ask about */
const RAJJU = {
  pada: ['Ashwini','Ashlesha','Magha','Jyeshtha','Mula','Revati'],
  kati: ['Bharani','Pushya','Purva Phalguni','Anuradha','Purva Ashadha','Uttara Bhadrapada'],
  nabhi: ['Krittika','Punarvasu','Uttara Phalguni','Vishakha','Uttara Ashadha','Purva Bhadrapada'],
  kantha: ['Rohini','Ardra','Hasta','Swati','Shravana','Shatabhisha'],
  siro: ['Mrigashira','Chitra','Dhanishta']
};
const rajjuOf = nak => Object.keys(RAJJU).find(k => RAJJU[k].includes(nak)) || null;
const VEDHA = [['Ashwini','Jyeshtha'],['Bharani','Anuradha'],['Krittika','Vishakha'],['Rohini','Swati'],
  ['Ardra','Shravana'],['Punarvasu','Uttara Ashadha'],['Pushya','Purva Ashadha'],['Ashlesha','Mula'],
  ['Magha','Revati'],['Purva Phalguni','Uttara Bhadrapada'],['Uttara Phalguni','Purva Bhadrapada'],
  ['Hasta','Shatabhisha'],['Chitra','Dhanishta']];
const vedhaOf = (a, b) => VEDHA.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

function pairParams(A, B) {           // A, B = user records
  const ca = A.chart, cb = B.chart;
  const ra = A.results || {}, rb = B.results || {};
  const out = [];
  const add = (name, group, v, w = 1) => { if (v != null && !Number.isNaN(v)) out.push({ name, group, v: c01(v), w }); };

  /* ---- astrology ---- */
  add('Vedic sun', 'Astro', signPair(ca.sun.sign, cb.sun.sign), 4);
  add('Vedic moon', 'Astro', signPair(ca.moon.sign, cb.moon.sign), 6);
  if (ca.western && cb.western) {
    add('Western sun', 'Astro', signPair(ca.western.sun, cb.western.sun), 3);
    add('Western moon', 'Astro', signPair(ca.western.moon, cb.western.moon), 3);
    add('Rising sign', 'Astro', signPair(ca.western.lagna, cb.western.lagna), 2);
  }
  add('Nakshatra', 'Astro', nakPair(ca, cb), 8);
  add('Venus', 'Astro', signPair(ca.venus.sign, cb.venus.sign), 3);
  add('Mars', 'Astro', signPair(ca.mars.sign, cb.mars.sign), 3);
  add('Element', 'Astro', ca.element === cb.element ? 1 : ELEM_OK[ca.element].includes(cb.element) ? 0.85 : 0.45, 2);
  add('Modality', 'Astro', ca.modality === cb.modality ? 0.6 : 0.9, 1);
  if (ca.lagna && cb.lagna) add('Lagna', 'Astro', signPair(ca.lagna.sign, cb.lagna.sign), 4);
  if (ca.manglik && cb.manglik) {
    const both = ca.manglik.is && cb.manglik.is, neither = !ca.manglik.is && !cb.manglik.is;
    add('Manglik', 'Astro', (both || neither) ? 1 : 0.4, 6);
  }
  const rjA = rajjuOf(ca.moon.nak), rjB = rajjuOf(cb.moon.nak);
  if (rjA && rjB) add('Rajju', 'Astro', rjA === rjB ? 0.3 : 1, 5);
  add('Vedha', 'Astro', vedhaOf(ca.moon.nak, cb.moon.nak) ? 0.3 : 1, 4);
  const male = A.gender === 'Man' ? ca : cb, female = A.gender === 'Man' ? cb : ca;
  add('Guna milan', 'Astro', astro.ashtakoota(male, female).pct, 22);

  /* ---- numerology ---- */
  const na = ca.numerology, nb = cb.numerology;
  add('Mulank', 'Numerology', astro.numPair(na.mulank, nb.mulank), 3);
  add('Bhagyank', 'Numerology', astro.numPair(na.bhagyank, nb.bhagyank), 3);
  if (na.namank && nb.namank) add('Namank', 'Numerology', astro.numPair(na.namank, nb.namank), 1);
  const gridA = Object.values(na.counts).filter(x => x > 0).length;
  const gridB = Object.values(nb.counts).filter(x => x > 0).length;
  add('Lo Shu', 'Numerology', 1 - Math.abs(gridA - gridB) / 9, 1);

  /* ---- chinese ---- */
  add('Chinese', 'Chinese', astro.chinesePair(ca.chinese, cb.chinese), 3);
  if (ca.systems && cb.systems) {
    add('Mayan tone', 'Other', ca.systems.mayan.tone === cb.systems.mayan.tone ? 1 : 0.5, 0.5);
    add('Mayan day', 'Other', ca.systems.mayan.mayan === cb.systems.mayan.mayan ? 1 : 0.55, 0.5);
    add('Celtic', 'Other', ca.systems.celtic === cb.systems.celtic ? 1 : 0.55, 0.5);
    add('Burmese day', 'Other', ca.systems.burmese === cb.systems.burmese ? 1 : 0.55, 0.5);
  }

  /* ---- personality (shared tests only) ---- */
  if (ra.big5 && rb.big5) {
    const da = ra.big5.dims, db2 = rb.big5.dims;
    for (const k of ['O', 'C', 'E', 'A', 'N']) add('Big Five ' + k, 'Personality', 1 - Math.abs(da[k] - db2[k]), 4);
  }
  if (ra.type && rb.type) {
    const ta = ra.type.summary.type, tb = rb.type.summary.type;
    add('Type letters', 'Personality', ta.split('').filter((l, i) => l === tb[i]).length / 4, 3);
  }
  if (ra.attach && rb.attach) {
    const x = ra.attach.summary, y = rb.attach.summary;
    add('Attachment', 'Personality', x.style === y.style ? 1 : x.style === 'secure' || y.style === 'secure' ? 0.7 : 0.35, 12);
  }
  if (ra.enneagram && rb.enneagram) {
    const x = ra.enneagram.summary.ennea, y = rb.enneagram.summary.ennea;
    const wing = (a, b) => Math.abs(a - b) === 1 || Math.abs(a - b) === 8;
    add('Enneagram', 'Personality', x === y ? 0.9 : wing(x, y) ? 0.8 : [1,4,7].includes(x) === [1,4,7].includes(y) ? 0.6 : 0.45, 5);
  }
  if (ra.love && rb.love) add('Love language', 'Personality', ra.love.summary.love === rb.love.summary.love ? 1 : 0.55);
  if (ra.disc && rb.disc) add('Social style', 'Personality', ra.disc.summary.disc === rb.disc.summary.disc ? 0.85 : 0.6);
  if (ra.humour && rb.humour) add('Humour', 'Personality', ra.humour.summary.humour === rb.humour.summary.humour ? 0.9 : 0.5);
  if (ra.conflict && rb.conflict) {
    const x = ra.conflict.summary.conflict, y = rb.conflict.summary.conflict;
    const bad = (p, q) => (p === 'Avoiding' && q === 'Competing') || (q === 'Avoiding' && p === 'Competing');
    add('Conflict style', 'Personality', x === y ? 0.85 : bad(x, y) ? 0.25 : 0.6, 4);
  }
  if (ra.chrono && rb.chrono) add('Body clock', 'Personality', ra.chrono.summary.chrono === rb.chrono.summary.chrono ? 0.9 : 0.5);
  return out;
}

function matchScore(A, B) {
  const params = pairParams(A, B);
  if (!params.length) return { score: 50, params: [], groups: {} };
  const totalW = params.reduce((s, p) => s + p.w, 0) || 1;
  const avg = params.reduce((s, p) => s + p.v * p.w, 0) / totalW;
  const groups = {};
  for (const p of params) {
    groups[p.group] = groups[p.group] || { n: 0, sum: 0, w: 0 };
    groups[p.group].n++; groups[p.group].sum += p.v * p.w; groups[p.group].w += p.w;
  }
  const groupScores = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, Math.round(g.sum / g.w * 100)]));
  return { score: Math.round(avg * 100), params, groups: groupScores };
}
const band = s => s >= 70 ? 'green' : s >= 45 ? 'yellow' : 'red';

/* ================================================================== *
 * the queue — presence based, first come first served, mutual preference
 * ================================================================== */
const wants = (u, other) => {
  if (u.pref === 'Anyone') return true;
  return (u.pref === 'Men') === (other.gender === 'Man');
};
const isOnline = u => u.lastSeen && now() - u.lastSeen < PRESENCE_MS;

function sweepQueue() {
  const before = db.queue.length;
  db.queue = db.queue.filter(e => {
    const u = db.users[e.uid];
    if (!u || !isOnline(u)) return false;
    if (u.suspended) return false;
    if (e.slot >= slotsOf(u)) return false;
    if (activeChats(u.id).some(c => c.a.slot === e.slot || c.b.slot === e.slot)) return false;
    return true;
  });
  return db.queue.length !== before;
}

function tryMatch() {
  sweepQueue();
  const created = [];
  const entries = [...db.queue].sort((a, b) => a.joinedAt - b.joinedAt);
  const used = new Set();
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const e1 = entries[i], u1 = db.users[e1.uid];
    if (!u1) continue;
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      const e2 = entries[j], u2 = db.users[e2.uid];
      if (!u2 || u2.id === u1.id) continue;
      if (!wants(u1, u2) || !wants(u2, u1)) continue;
      // both need a free slot
      const busy = (u, slot) => activeChats(u.id).some(c => c.a.slot === slot || c.b.slot === slot);
      if (busy(u1, e1.slot) || busy(u2, e2.slot)) continue;
      const chat = makeChat(u1, e1.slot, u2, e2.slot);
      used.add(i); used.add(j);
      created.push(chat);
      break;
    }
  }
  if (created.length) {
    db.queue = db.queue.filter((e, k) => !used.has(entries.indexOf(e)));
    save();
  }
  return created;
}

function makeChat(u1, s1, u2, s2) {
  const m = matchScore(u1, u2);
  const chat = {
    id: uid(), a: { uid: u1.id, slot: s1 }, b: { uid: u2.id, slot: s2 },
    startedAt: now(), lastAt: now(), messages: [], endedAt: null, endedBy: null, score: m.score, groups: m.groups
  };
  db.chats[chat.id] = chat;
  u1.stats = u1.stats || {}; u2.stats = u2.stats || {};
  return chat;
}

/* ================================================================== *
 * public shapes
 * ================================================================== */
function publicUser(u) {
  const cibil = cibilOf(u);
  return {
    id: u.id, name: u.name, status: u.status || '', gender: u.gender, pref: u.pref,
    city: u.city, age: ageOf(u.dob), tier: tierOf(cibil).name, slots: slotsOf(u),
    avatar: u.avatar || null,
    suspended: !!u.suspended
  };
}
function ageOf(dob) {
  const b = new Date(dob), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  const m = n.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--;
  return a;
}
function chatView(c, me) {
  const otherId = c.a.uid === me.id ? c.b.uid : c.a.uid;
  const other = db.users[otherId];
  return {
    id: c.id, score: c.score, band: band(c.score), groups: c.groups,
    startedAt: c.startedAt, endedAt: c.endedAt, endedBy: c.endedBy === me.id ? 'me' : 'them',
    peer: other ? { id: other.id, avatar: other.avatar || null, name: other.name, status: other.status || '', age: ageOf(other.dob), city: other.city, tier: tierOf(cibilOf(other)).name } : null,
    messages: c.messages.map(m => ({ from: m.uid === me.id ? 'me' : 'them', text: m.text, at: m.at })),
    mySlot: c.a.uid === me.id ? c.a.slot : c.b.slot,
    peerTyping: !!(c.typing && c.typing[otherId] && now() - c.typing[otherId] < 5000),
    blocked: (me.blocked || []).includes(otherId)
  };
}

/* ================================================================== *
 * http
 * ================================================================== */
const send = (res, code, body) => {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
};
const bad = (res, code, msg) => send(res, code, { error: msg });
const readBody = req => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 2e6) reject(new Error('too large')); });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('bad json')); } });
  req.on('error', reject);
});

const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = now();
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.count++;
  return b.count <= max;
}
const ipOf = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x';

function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token || !db.tokens[token]) return null;
  return db.users[db.tokens[token]] || null;
}
const newSession = u => { const t = crypto.randomBytes(24).toString('hex'); db.tokens[t] = u.id; return t; };

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname, method = req.method;
    try {
      if (method === 'GET' && p === '/geo.json') {
        return send(res, 200, fs.readFileSync(path.join(__dirname, 'geo.json'), 'utf8'),
          { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      }
      if (method === 'GET' && (p === '/' || p === '/index.html')) {
        const a = path.join(__dirname, 'index.html'), b = path.join(PUBLIC_DIR, 'index.html');
        return send(res, 200, fs.readFileSync(fs.existsSync(a) ? a : b, 'utf8'));
      }
      if (method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, version: VERSION, store: store.kind, lastSaveError, users: Object.keys(db.users).length, queued: db.queue.length, chats: Object.keys(db.chats).length });

      /* ---------- auth ---------- */
      if (method === 'POST' && p === '/api/signup/start') {
        if (!rateLimit('signup:' + ipOf(req), 20, 60_000)) return bad(res, 429, 'Too many signups. Wait a minute.');
        const b = await readBody(req);
        const email = String(b.email || '').trim().toLowerCase();
        const password = String(b.password || '');
        const name = String(b.name || '').trim().slice(0, 24);
        const status = String(b.status || '').trim().slice(0, 50);
        const gender = b.gender === 'Man' ? 'Man' : b.gender === 'Woman' ? 'Woman' : null;
        const pref = ['Men', 'Women', 'Anyone'].includes(b.pref) ? b.pref : null;
        const dob = String(b.dob || '');
        const tob = /^\d{2}:\d{2}$/.test(String(b.tob || '')) ? String(b.tob) : '';
        const city = String(b.city || '').trim();

        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 400, 'That email does not look right.');
        if (password.length < 8) return bad(res, 400, 'Password needs 8 characters.');
        if (!name) return bad(res, 400, 'A name is needed — it is what people see.');
        if (!gender) return bad(res, 400, 'Pick man or woman.');
        if (!pref) return bad(res, 400, 'Pick who you want to meet.');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return bad(res, 400, 'Date of birth needed for the charts.');
        if (ageOf(dob) < 18) return bad(res, 400, 'You must be 18 or older.');
        if (ageOf(dob) > 100) return bad(res, 400, 'That date does not look right.');
        if (!city) return bad(res, 400, 'Birth place is needed.');
        const foundPlace = lookupPlace(city);
        if (!foundPlace) return bad(res, 400, 'We do not recognise that place. Start typing and pick one from the list — the chart needs real coordinates.');
        if (Object.values(db.users).some(u => u.email === email)) return bad(res, 409, 'That email is already registered.');

        const code = sixDigits();
        db.pending = db.pending || {};
        db.pending[email] = {
          code, expires: now() + 10 * 60_000, attempts: 0,
          payload: { password, name, status, gender, pref, dob, tob, city: foundPlace.name,
                     lat: foundPlace.lat, lon: foundPlace.lon }
        };
        save();
        let mailed;
        try {
          mailed = await sendMail(email, 'Your Milao code',
            `Your verification code is ${code}.\n\nIt expires in 10 minutes. If this was not you, ignore this email.`);
        } catch (e) {
          delete db.pending[email]; save();
          return bad(res, 502, 'Could not send the code. Try again in a minute.');
        }
        return send(res, 200, { pending: true, devCode: mailed.dev ? code : undefined });
      }

      if (method === 'POST' && p === '/api/signup/verify') {
        const b = await readBody(req);
        const email = String(b.email || '').trim().toLowerCase();
        const code = String(b.code || '').trim();
        const pend = (db.pending || {})[email];
        if (!pend) return bad(res, 400, 'Start again — that code has expired.');
        if (pend.expires < now()) { delete db.pending[email]; save(); return bad(res, 400, 'That code expired. Start again.'); }
        if (pend.attempts >= 5) { delete db.pending[email]; save(); return bad(res, 429, 'Too many tries. Start again.'); }
        pend.attempts++;
        if (code !== pend.code) { save(); return bad(res, 400, 'Wrong code.'); }
        if (Object.values(db.users).some(u => u.email === email)) return bad(res, 409, 'That email is already registered.');

        const p2 = pend.payload;
        const { salt, hash } = makePw(p2.password);
        const user = {
          id: uid(), email, salt, hash, name: p2.name, status: p2.status, gender: p2.gender,
          pref: p2.pref, dob: p2.dob, tob: p2.tob, city: p2.city,
          createdAt: now(), lastSeen: now(), results: {}, cibilAdj: 0,
          stats: { chats: 0, messages: 0, skips: 0, leaves: 0, skipped: 0, reported: 0 },
          chart: astro.chart({ dob: p2.dob, tob: p2.tob, name: p2.name, place: p2.city, lat: p2.lat, lon: p2.lon })
        };
        db.users[user.id] = user;
        delete db.pending[email];
        save();
        return send(res, 200, { token: newSession(user), user: publicUser(user) });
      }

      if (method === 'POST' && p === '/api/password/forgot') {
        if (!rateLimit('forgot:' + ipOf(req), 10, 60_000)) return bad(res, 429, 'Too many requests. Wait a minute.');
        const b = await readBody(req);
        const email = String(b.email || '').trim().toLowerCase();
        const u = Object.values(db.users).find(x => x.email === email);
        if (u) {
          const code = sixDigits();
          u.reset = { code, expires: now() + 15 * 60_000, attempts: 0 };
          save();
          try {
            await sendMail(email, 'Reset your Milao password',
              `Your reset code is ${code}.\n\nIt expires in 15 minutes.`);
          } catch (e) { /* say nothing to the caller */ }
        }
        return send(res, 200, { sent: true });     // never reveal whether the email exists
      }

      if (method === 'POST' && p === '/api/password/reset') {
        const b = await readBody(req);
        const email = String(b.email || '').trim().toLowerCase();
        const code = String(b.code || '').trim();
        const password = String(b.password || '');
        if (password.length < 8) return bad(res, 400, 'Password needs 8 characters.');
        const u = Object.values(db.users).find(x => x.email === email);
        if (!u || !u.reset || u.reset.expires < now()) return bad(res, 400, 'That code is no longer valid.');
        if (u.reset.attempts >= 5) { delete u.reset; save(); return bad(res, 429, 'Too many tries. Request a new code.'); }
        u.reset.attempts++;
        if (code !== u.reset.code) { save(); return bad(res, 400, 'Wrong code.'); }
        const { salt, hash } = makePw(password);
        u.salt = salt; u.hash = hash; delete u.reset;
        // every existing session dies with the old password
        for (const [tok, id] of Object.entries(db.tokens)) if (id === u.id) delete db.tokens[tok];
        save();
        return send(res, 200, { ok: true, token: newSession(u), user: publicUser(u) });
      }

      if (method === 'POST' && p === '/api/login') {
        if (!rateLimit('login:' + ipOf(req), 20, 60_000)) return bad(res, 429, 'Too many attempts.');
        const b = await readBody(req);
        const u = Object.values(db.users).find(x => x.email === String(b.email || '').trim().toLowerCase());
        if (!u || !checkPw(u, String(b.password || ''))) return bad(res, 401, 'Wrong email or password.');
        if (u.suspended) return bad(res, 403, 'This account is suspended pending review.');
        u.lastSeen = now(); save();
        return send(res, 200, { token: newSession(u), user: publicUser(u) });
      }

      const me = authUser(req);
      if (p.startsWith('/api/') && !me && !p.startsWith('/api/dev') && !p.startsWith('/api/admin')) return bad(res, 401, 'Sign in first.');
      if (me) {
        if (me.suspended) return bad(res, 403, 'This account is suspended pending review.');
        me.lastSeen = now();
      }

      if (method === 'GET' && p === '/api/me') {
        return send(res, 200, {
          user: publicUser(me), email: me.email, status: me.status, tob: me.tob || '',
          chart: me.chart, results: me.results,
          cibil: { score: cibilOf(me), tier: tierOf(cibilOf(me)).name, slots: slotsOf(me), next: TIERS.find(t => t.min > cibilOf(me)) || null },
          stats: me.stats
        });
      }

      if (method === 'POST' && p === '/api/avatar') {
        const b = await readBody(req);
        const clean = {};
        for (const k of ['skin','hair','hairColor','eyes','brow','mouth','glasses','hat']) {
          const v = Number(b[k]);
          if (Number.isInteger(v) && v >= 0 && v < 12) clean[k] = v;
        }
        me.avatar = clean;
        save();
        return send(res, 200, { avatar: me.avatar });
      }

      if (method === 'DELETE' && p === '/api/account') {
        const id = me.id;
        for (const c of Object.values(db.chats)) {
          if (c.a.uid === id || c.b.uid === id) delete db.chats[c.id];
        }
        db.queue = db.queue.filter(e => e.uid !== id);
        db.notes = (db.notes || []).filter(n => n.from !== id && n.to !== id);
        for (const [tok, uid2] of Object.entries(db.tokens)) if (uid2 === id) delete db.tokens[tok];
        delete db.users[id];
        save();
        return send(res, 200, { deleted: true });
      }

      if (method === 'POST' && p === '/api/profile') {
        const b = await readBody(req);
        let recompute = false;
        if (typeof b.status === 'string') me.status = b.status.trim().slice(0, 50);
        if (typeof b.name === 'string' && b.name.trim()) { me.name = b.name.trim().slice(0, 24); recompute = true; }
        if (['Men', 'Women', 'Anyone'].includes(b.pref)) me.pref = b.pref;
        if (typeof b.dob === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.dob) && b.dob !== me.dob) {
          if (ageOf(b.dob) < 18) return bad(res, 400, 'You must be 18 or older.');
          if (ageOf(b.dob) > 100) return bad(res, 400, 'That date does not look right.');
          me.dob = b.dob; recompute = true;
        }
        if (typeof b.tob === 'string' && b.tob !== me.tob) {
          me.tob = /^\d{2}:\d{2}$/.test(b.tob) ? b.tob : '';
          recompute = true;
        }
        let newPlace = null;
        if (typeof b.city === 'string' && b.city.trim() && b.city.trim() !== me.city) {
          const fp = lookupPlace(b.city);
          if (!fp) return bad(res, 400, 'We do not recognise that place — pick one from the list.');
          me.city = fp.name; newPlace = fp; recompute = true;
        }
        if (recompute) {
          const fp = newPlace || lookupPlace(me.city);
          me.chart = astro.chart({ dob: me.dob, tob: me.tob, name: me.name, place: fp ? fp.name : me.city,
            lat: fp ? fp.lat : undefined, lon: fp ? fp.lon : undefined });
        }
        save();
        return send(res, 200, { user: publicUser(me), chart: me.chart, cibil: { score: cibilOf(me), tier: tierOf(cibilOf(me)).name, slots: slotsOf(me) } });
      }

      if (method === 'GET' && p === '/api/tests') return send(res, 200, { tests: publicTests() });

      if (method === 'POST' && p.startsWith('/api/tests/')) {
        const id = p.split('/')[3];
        if (!TESTS[id]) return bad(res, 404, 'No such test.');
        const b = await readBody(req);
        let scored;
        try { scored = scoreTest(id, b.answers || {}); } catch (e) { return bad(res, 400, e.message); }
        me.results[id] = { dims: scored.dims, summary: scored.summary, at: now() };
        save();
        return send(res, 200, { result: scored, cibil: { score: cibilOf(me), tier: tierOf(cibilOf(me)).name, slots: slotsOf(me) } });
      }

      /* ---------- queue ---------- */
      if (method === 'POST' && p === '/api/queue/join') {
        const b = await readBody(req);
        const slot = Number(b.slot);
        if (!(slot >= 0 && slot < slotsOf(me))) return bad(res, 400, 'That slot does not exist for your tier.');
        if (activeChats(me.id).some(c => c.a.slot === slot || c.b.slot === slot)) return bad(res, 409, 'That slot is busy.');
        if (db.queue.some(e => e.uid === me.id && e.slot === slot)) return send(res, 200, { ok: true, already: true });
        db.queue.push({ uid: me.id, slot, joinedAt: now() });
        const chats = tryMatch();
        save();
        return send(res, 200, { ok: true, matched: chats.length, waiting: db.queue.filter(e => e.uid === me.id).length });
      }

      if (method === 'POST' && p === '/api/queue/leave') {
        const b = await readBody(req);
        const slot = Number(b.slot);
        db.queue = db.queue.filter(e => !(e.uid === me.id && e.slot === slot));
        save();
        return send(res, 200, { ok: true });
      }

      /* ---------- the main poll ---------- */
      if (method === 'GET' && p === '/api/state') {
        const chats = tryMatch();
        const mine = activeChats(me.id);
        const queued = db.queue.filter(e => e.uid === me.id);
        const waiting = db.queue
          .map(e => ({ e, u: db.users[e.uid] }))
          .filter(x => x.u)
          .sort((a, b) => a.e.joinedAt - b.e.joinedAt);
        const slots = [];
        for (let i = 0; i < slotsOf(me.id); i++) {
          const chat = mine.find(c => c.a.slot === i || c.b.slot === i);
          const myEntry = queued.find(e => e.slot === i);
          let position = null;
          if (myEntry) {
            const ahead = waiting.filter(x => x.e.joinedAt < myEntry.joinedAt && wants(x.u, me) && wants(me, x.u)).length;
            position = ahead + 1;
          }
          const last = chat && chat.messages.length ? chat.messages[chat.messages.length - 1] : null;
          slots.push({
            index: i,
            chatId: chat ? chat.id : null,
            queued: !!myEntry,
            position,
            peer: chat ? chatView(chat, me).peer : null,
            score: chat ? chat.score : null,
            band: chat ? band(chat.score) : null,
            messages: chat ? chat.messages.length : 0,
            lastFrom: last ? (last.uid === me.id ? 'me' : 'them') : null
          });
        }
        return send(res, 200, {
          tier: tierOf(cibilOf(me)).name, cibil: cibilOf(me), slots,
          waiting: queued.length, queueSize: db.queue.length,
          newChats: chats.filter(c => c.a.uid === me.id || c.b.uid === me.id).map(c => c.id),
          online: Object.values(db.users).filter(u => isOnline(u) && u.id !== me.id).length
        });
      }

      if (method === 'GET' && p.startsWith('/api/chats/')) {
        const id = p.split('/')[3];
        const c = db.chats[id];
        if (!c || (c.a.uid !== me.id && c.b.uid !== me.id)) return bad(res, 404, 'No such chat.');
        return send(res, 200, { chat: chatView(c, me) });
      }

      if (method === 'POST' && p.startsWith('/api/chats/')) {
        const parts = p.split('/');
        const c = db.chats[parts[3]];
        if (!c || (c.a.uid !== me.id && c.b.uid !== me.id)) return bad(res, 404, 'No such chat.');
        const otherId = c.a.uid === me.id ? c.b.uid : c.a.uid;
        const other = db.users[otherId];

        if (parts[4] === 'typing') {
          c.typing = c.typing || {};
          c.typing[me.id] = now();
          return send(res, 200, { ok: true });
        }

        if (parts[4] === 'messages' && method === 'POST') {
          if (c.endedAt) return bad(res, 409, 'This chat has ended.');
          if (!rateLimit('msg:' + me.id, 60, 60_000)) return bad(res, 429, 'Slow down.');
          const b = await readBody(req);
          const text = String(b.text || '').trim().slice(0, 1000);
          if (!text) return bad(res, 400, 'Empty message.');
          const firstReply = c.messages.length > 0 && c.messages[c.messages.length - 1].uid !== me.id
            && !c.messages.some(m => m.uid === me.id);
          c.messages.push({ uid: me.id, text, at: now() });
          c.lastAt = now();
          me.stats.messages = (me.stats.messages || 0) + 1;
          bump(me, 'message');
          if (firstReply && now() - c.messages[c.messages.length - 2].at < 5 * 60_000) bump(me, 'fastReply');
          save();
          return send(res, 200, { chat: chatView(c, me) });
        }

        if (parts[4] === 'leave' && method === 'POST') {
          if (c.endedAt) return send(res, 200, { chat: chatView(c, me) });
          c.endedAt = now(); c.endedBy = me.id;
          const spoke = c.messages.some(m => m.uid === me.id);
          if (spoke) { bump(me, 'leave'); me.stats.leaves++; }
          else { bump(me, 'skip'); me.stats.skips++; if (other) { bump(other, 'skipped'); other.stats.skipped = (other.stats.skipped || 0) + 1; } }
          const both = c.messages.filter(m => m.uid === c.a.uid).length >= 3 && c.messages.filter(m => m.uid === c.b.uid).length >= 3;
          if (both) { const A2 = db.users[c.a.uid], B2 = db.users[c.b.uid];
            if (A2) A2.stats.completed = (A2.stats.completed || 0) + 1;
            if (B2) B2.stats.completed = (B2.stats.completed || 0) + 1; }
          if (both) { const A = db.users[c.a.uid], B = db.users[c.b.uid]; if (A) bump(A, 'longChat'); if (B) bump(B, 'longChat'); }
          save();
          return send(res, 200, { chat: chatView(c, me), cibil: { score: cibilOf(me), tier: tierOf(cibilOf(me)).name } });
        }

        if (parts[4] === 'report' && method === 'POST') {
          const b = await readBody(req);
          const reason = String(b.reason || 'other').slice(0, 40);
          let suspendedNow = false;
          if (other) {
            bump(other, 'reported');
            other.stats.reported = (other.stats.reported || 0) + 1;
            db.reports.push({ id: uid(), chat: c.id, from: me.id, to: otherId, reason, at: now() });
            // distinct reporters only — one person cannot suspend someone alone
            const distinct = new Set(db.reports.filter(r => r.to === otherId).map(r => r.from)).size;
            if (reason === 'underage') { other.suspended = true; other.suspendReason = 'underage report'; suspendedNow = true; }
            else if (distinct >= REPORT_SUSPEND_AT) { other.suspended = true; other.suspendReason = distinct + ' separate reports'; suspendedNow = true; }
          } else {
            db.reports.push({ id: uid(), chat: c.id, from: me.id, to: otherId, reason, at: now() });
          }
          c.endedAt = c.endedAt || now();
          save();
          return send(res, 200, { ok: true, suspended: suspendedNow });
        }
      }

      /* ---------- legal ---------- */
      if (method === 'GET' && ['/terms', '/privacy', '/guidelines'].includes(p)) {
        return send(res, 200, legalPage(p.slice(1)), { 'Content-Type': 'text/html; charset=utf-8' });
      }

      /* ---------- admin ---------- */
      if (method === 'GET' && p === '/admin') return send(res, 200, adminPage(url.searchParams.get('token') || ''));

      if (p.startsWith('/api/admin/')) {
        if (!ADMIN_TOKEN || url.searchParams.get('token') !== ADMIN_TOKEN) return bad(res, 403, 'Admin token required.');
        if (method === 'GET' && p === '/api/admin/stats') {
          const users = Object.values(db.users);
          const day = 24 * 3600e3;
          const chats = Object.values(db.chats);
          const msgs = chats.reduce((n, c) => n + c.messages.length, 0);
          const chatted = new Set(chats.flatMap(c => [c.a.uid, c.b.uid]));
          const replied = chats.filter(c => new Set(c.messages.map(m => m.uid)).size > 1).length;
          return send(res, 200, {
            users: users.length,
            signupsToday: users.filter(u => now() - u.createdAt < day).length,
            activeToday: users.filter(u => now() - u.lastSeen < day).length,
            withTests: users.filter(u => Object.keys(u.results || {}).length > 0).length,
            chatted: chatted.size,
            chats: chats.length,
            chatsWithReply: replied,
            messages: msgs,
            avgMessagesPerChat: chats.length ? +(msgs / chats.length).toFixed(1) : 0,
            reports: (db.reports || []).length,
            reportsPer100Chats: chats.length ? +((db.reports || []).length / chats.length * 100).toFixed(1) : 0,
            suspended: users.filter(u => u.suspended).length,
            queued: db.queue.length,
            store: store.kind
          });
        }
        if (method === 'GET' && p === '/api/admin/reports') {
          const list = (db.reports || []).slice(-200).reverse().map(r => {
            const from = db.users[r.from], to = db.users[r.to];
            return {
              id: r.id, at: r.at, reason: r.reason,
              from: from ? { id: from.id, name: from.name, email: from.email } : null,
              to: to ? { id: to.id, name: to.name, email: to.email, suspended: !!to.suspended, reported: (to.stats || {}).reported || 0 } : null
            };
          });
          return send(res, 200, { reports: list });
        }
        if (method === 'POST' && p === '/api/admin/suspend') {
          const b = await readBody(req);
          const u = db.users[String(b.userId || '')];
          if (!u) return bad(res, 404, 'No such user.');
          u.suspended = !!b.suspend;
          save();
          return send(res, 200, { ok: true, suspended: u.suspended });
        }
      }

      /* ---------- dev ---------- */
      if (method === 'GET' && p === '/api/dev/users') {
        if (!ADMIN_TOKEN || url.searchParams.get('token') !== ADMIN_TOKEN) return bad(res, 403, 'Dev token required.');
        return send(res, 200, {
          users: Object.values(db.users).map(u => ({
            id: u.id, email: u.email, name: u.name, gender: u.gender, city: u.city,
            cibil: cibilOf(u), tier: tierOf(cibilOf(u)).name, tests: Object.keys(u.results || {}).length,
            suspended: !!u.suspended, stats: u.stats
          })),
          reports: db.reports.slice(-100),
          queued: db.queue.length
        });
      }

      return bad(res, 404, 'Not found');
    } catch (err) {
      console.error(err);
      return bad(res, 500, 'Server error');
    }
  });
}

function legalPage(kind) {
  const g = process.env.GRIEVANCE_EMAIL || 'grievance@milaochat.com';
  const updated = '15 November 2026';
  const wrap = (title, body) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Milao</title>
<style>body{font:16px/1.65 -apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;padding:28px 20px 60px;color:#2B1A1D;background:#FBF2EF}
h1{font-size:26px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 6px}p,li{color:#4a3538}small{color:#7B5D60}
a{color:#B0203C}hr{border:0;border-top:1px solid #e6d5d8;margin:26px 0}</style>
<h1>${title}</h1><small>Last updated ${updated}</small><hr>${body}
<hr><p><small>Milao is operated from India. Questions and complaints: <a href="mailto:${g}">${g}</a></small></p>`;

  if (kind === 'terms') return wrap('Terms of use', `
<p>Milao is a service for adults to meet strangers through text conversations. By creating an account you confirm you are 18 or older and that the information you give — including your birth date, time and place — is accurate.</p>
<h2>What you agree to</h2>
<ul><li>One account per person. No impersonating anyone.</li>
<li>No harassment, threats, hate, sexual content involving minors, or attempts to move a conversation somewhere it is not wanted.</li>
<li>No spam, advertising, or using Milao to sell anything.</li>
<li>You are responsible for what you send. Screenshots exist; treat the other person as a person.</li></ul>
<h2>What we do</h2>
<p>We compute a compatibility score between two people from the information both have given. The score is our opinion, not a prediction, and it carries no guarantee.</p>
<p>We may suspend or remove an account for breaking these terms, or on a credible report. Reports about someone being under 18 suspend the account until a human reviews it.</p>
<h2>What we do not promise</h2>
<p>Milao is provided as it is. We do not vet the identity of users, we do not run background checks, and we cannot guarantee who you are speaking to. Meet strangers carefully.</p>
<h2>Ending it</h2>
<p>You can delete your account at any time from your profile. That removes your account, your chats and your messages.</p>`);

  if (kind === 'privacy') return wrap('Privacy', `
<p>This page says what we hold, why, and what you can ask us to do with it.</p>
<h2>What we collect</h2>
<ul><li><b>Email</b> — for signing in and sending you a code. Never shown to other users.</li>
<li><b>Birth date, time and place</b> — used to compute the astrology parts of your profile. Place is stored as a name and coordinates.</li>
<li><b>Your test answers and the results</b> — the personality side of your profile.</li>
<li><b>Messages</b> — stored so both people can see the conversation. They are not end-to-end encrypted.</li>
<li><b>Activity</b> — when you sign in, whether you reply, reports made about you.</li></ul>
<h2>What other users see</h2>
<p>Your chosen name, your status line, your age, your city, and the compatibility score between you and them. Never your email. Never your birth details.</p>
<h2>How long we keep it</h2>
<p>While your account exists. Deleting your account deletes your profile, your chats and your messages.</p>
<h2>Your rights</h2>
<p>You can ask for a copy of your data, ask us to correct it, or ask us to delete it. Write to the address below and we will respond within 30 days.</p>
<h2>Who else sees it</h2>
<p>We use a database host and an email provider to run the service. We do not sell data and we do not run advertising trackers.</p>`);

  return wrap('Community guidelines', `
<p>Milao only works if strangers can talk without being made to feel unsafe. These are the lines.</p>
<h2>Not allowed</h2>
<ul><li>Anyone under 18. If you are under 18, leave.</li>
<li>Sexual content, requests for it, or pressuring anyone into it.</li>
<li>Harassment, threats, casteist, communal or sexual slurs.</li>
<li>Sharing someone's private information, photos or screenshots without consent.</li>
<li>Impersonation, scams, money requests, advertising.</li></ul>
<h2>What to do</h2>
<p>If a conversation goes wrong, leave it — leaving costs you nothing that matters. Report the person from inside the chat. If they are under 18, choose that reason; it suspends the account immediately pending review.</p>
<p>You can block someone from the chat menu. Blocking stops them being matched with you again.</p>
<h2>What we act on</h2>
<p>Reports are reviewed by a human. We look at the conversation, the account's history and how many independent reports exist — a single report does not get someone banned, and repeated reports from the same person do not stack.</p>`);
}

function adminPage(token) {
  const ok = ADMIN_TOKEN && token === ADMIN_TOKEN;
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Milao admin</title>
<style>
body{font:14px/1.55 ui-monospace,SFMono-Regular,monospace;background:#1A1512;color:#F3EADC;padding:22px;max-width:880px;margin:auto}
h1{font-size:15px;letter-spacing:.16em;text-transform:uppercase;color:#D9885A;margin:0 0 4px}
p.sub{color:#B3A392;margin:0 0 20px;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:24px}
.k{background:#241C17;border:1px solid #3A2E24;border-radius:10px;padding:12px}
.k b{display:block;font-size:22px;color:#F3EADC}
.k span{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#8A7B6B}
h2{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#B3A392;margin:22px 0 8px}
table{width:100%;border-collapse:collapse;font-size:12px}
td,th{border-bottom:1px solid #3A2E24;padding:7px 6px;text-align:left;vertical-align:top}
th{color:#8A7B6B;font-weight:400;font-size:10px;letter-spacing:.1em;text-transform:uppercase}
button{font:inherit;font-size:11px;background:#3A2418;color:#D9885A;border:1px solid #5A3A24;border-radius:7px;padding:5px 9px;cursor:pointer}
.tag{font-size:10px;padding:2px 6px;border-radius:99px;background:#3A1F1A;color:#E58B7F}
</style>
<h1>Milao admin</h1>
${ok ? `<p class="sub">Private. This page shows emails. Do not share the link.</p>
<div class="grid" id="stats"></div>
<h2>Reports</h2>
<table><thead><tr><th>when</th><th>reason</th><th>reported</th><th>by</th><th></th></tr></thead><tbody id="reports"></tbody></table>
<script>
const T = '${token}';
const ago = t => { const s = Math.round((Date.now() - t) / 60000); return s < 60 ? s + 'm' : Math.round(s / 60) + 'h'; };
async function load() {
  const s = await (await fetch('/api/admin/stats?token=' + T)).json();
  document.getElementById('stats').innerHTML = Object.entries(s).map(([k, v]) =>
    '<div class="k"><b>' + v + '</b><span>' + k.replace(/([A-Z])/g, ' $1').toLowerCase() + '</span></div>').join('');
  const r = await (await fetch('/api/admin/reports?token=' + T)).json();
  document.getElementById('reports').innerHTML = r.reports.map(x =>
    '<tr><td>' + ago(x.at) + '</td><td>' + x.reason + '</td><td>' +
    (x.to ? x.to.name + '<br><small>' + x.to.email + '</small>' : '?') +
    (x.to && x.to.suspended ? ' <span class="tag">suspended</span>' : '') +
    '</td><td>' + (x.from ? x.from.name : '?') + '</td><td><button data-id="' + (x.to ? x.to.id : '') + '" data-s="' + (x.to && x.to.suspended ? '0' : '1') + '">' + (x.to && x.to.suspended ? 'unsuspend' : 'suspend') + '</button></td></tr>'
  ).join('') || '<tr><td colspan="5" style="color:#8A7B6B">no reports yet</td></tr>';
}
document.addEventListener('click', async e => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  await fetch('/api/admin/suspend?token=' + T, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: b.dataset.id, suspend: b.dataset.s === '1' }) });
  load();
});
load(); setInterval(load, 15000);
</script>` : `<p class="sub">Open as /admin?token=YOUR_ADMIN_TOKEN after setting ADMIN_TOKEN on the server.</p>`}`;
}

if (require.main === module) {
  initStore()
    .then(kind => console.log(`  store: ${kind}${kind === 'json' ? '  (set DATABASE_URL to make it durable)' : ''}`))
    .catch(e => console.error('store init failed:', e.message))
    .finally(() => {
      const server = createServer();
      setInterval(() => { if (sweepQueue()) save(); }, 5000);
      server.listen(PORT, '0.0.0.0', () => {
        console.log(`\n  Milao on http://localhost:${PORT}`);
        for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  network:  http://${a.address}:${PORT}`);
        if (ADMIN_TOKEN) console.log(`  admin:    http://localhost:${PORT}/admin?token=YOUR_ADMIN_TOKEN`);
        console.log('');
      });
      const shutdown = () => {
        flush().finally(() => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
      };
      process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
    });
}

module.exports = { createServer, scoreTest, matchScore, cibilOf, slotsOf, tierOf, TESTS, TEST_ORDER, db: () => db, sweepQueue, tryMatch };
