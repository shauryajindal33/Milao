'use strict';
process.env.DATA_DIR = require('node:path').join(__dirname, 'data-test');
process.env.ADMIN_TOKEN = 'dev';
delete process.env.RESEND_API_KEY;
delete process.env.DATABASE_URL;
require('node:fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const { createServer, db, cibilOf, matchScore, TESTS, TEST_ORDER } = require('./server');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  → ' + x : '')); } };
const answersFor = id => { const a = {}; for (const it of TESTS[id].items) a[it.id] = it.options ? 0 : 3; return a; };

(async () => {
  const server = createServer();
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (m, p, b, t) => {
    const r = await fetch(base + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: b ? JSON.stringify(b) : undefined });
    let j = {}; try { j = await r.json(); } catch {}
    return { status: r.status, json: j };
  };
  const signup = async body => {
    const s = await api('POST', '/api/signup/start', body);
    if (s.status !== 200) return s;
    return api('POST', '/api/signup/verify', { email: body.email, code: s.json.devCode });
  };
  const person = (o = {}) => Object.assign({ email: 'a@x.com', password: 'password123', name: 'Aarav', status: 'Coffee', gender: 'Man', pref: 'Women', dob: '1997-06-14', tob: '06:40', city: 'Bengaluru' }, o);

  console.log('\n— places —');
  const geo = await (await fetch(base + '/geo.json')).json();
  ok('place index served', Array.isArray(geo) && geo.length > 6000, String(geo.length));
  ok('entries carry state and coordinates', geo[0].length >= 4 && typeof geo[0][2] === 'number');
  const badPlace = await api('POST', '/api/signup/start', person({ city: 'Nowhereville' }));
  ok('unknown place rejected', badPlace.status === 400, JSON.stringify(badPlace.json).slice(0, 60));
  const fuzzy = await api('POST', '/api/signup/start', person({ email: 'f@x.com', city: 'dehradun' }));
  ok('lower-case place accepted', fuzzy.status === 200);

  console.log('\n— signup —');
  const start = await api('POST', '/api/signup/start', person());
  const A = await api('POST', '/api/signup/verify', { email: 'a@x.com', code: start.json.devCode });
  const AT = A.json.token;
  ok('account created after code', A.status === 200 && !!AT);
  const me = await api('GET', '/api/me', null, AT);
  ok('chart uses the real coordinates', Math.abs(me.json.chart.place.lat - 12.972) < 0.2, JSON.stringify(me.json.chart.place));
  ok('place name stored', me.json.chart.place.name === 'Bengaluru');
  const B = await signup(person({ email: 'b@x.com', name: 'Riya', gender: 'Woman', pref: 'Men', dob: '1998-08-21', tob: '', city: 'Delhi' }));
  const BT = B.json.token;

  console.log('\n— the test suite —');
  ok('five tests only', TEST_ORDER.length === 5, TEST_ORDER.join(','));
  ok('the weak ones are gone', !['disc', 'humour', 'chrono', 'love'].some(t => TEST_ORDER.includes(t)));
  ok('big five has 20 items', TESTS.big5.items.length === 20);
  ok('attachment has 12', TESTS.attach.items.length === 12);
  ok('enneagram has 18', TESTS.enneagram.items.length === 18);
  for (const id of TEST_ORDER) {
    const r = await api('POST', '/api/tests/' + id, { answers: answersFor(id) }, AT);
    const r2 = await api('POST', '/api/tests/' + id, { answers: answersFor(id) }, BT);
    if (r.status !== 200 || r2.status !== 200) ok('scored ' + id, false, JSON.stringify(r.json));
  }
  ok('all five scored', Object.keys((await api('GET', '/api/me', null, AT)).json.results).length === 5);

  console.log('\n— weights —');
  const uA = Object.values(db().users).find(u => u.email === 'a@x.com');
  const uB = Object.values(db().users).find(u => u.email === 'b@x.com');
  const m = matchScore(uA, uB);
  ok('params carry weights', m.params.every(p => typeof p.w === 'number' && p.w > 0));
  const astroW = m.params.filter(p => p.group === 'Astro').reduce((s, p) => s + p.w, 0);
  const persW = m.params.filter(p => p.group === 'Personality').reduce((s, p) => s + p.w, 0);
  const totalW = m.params.reduce((s, p) => s + p.w, 0);
  ok('astrology carries the most weight', astroW / totalW > 0.45, (astroW / totalW * 100).toFixed(0) + '%');
  ok('personality still substantial', persW / totalW > 0.25, (persW / totalW * 100).toFixed(0) + '%');
  ok('guna milan is the heaviest single rule', m.params.find(p => p.name === 'Guna milan').w === 22);
  ok('rajju and vedha present', m.params.some(p => p.name === 'Rajju') && m.params.some(p => p.name === 'Vedha'));
  ok('manglik scored', m.params.some(p => p.name === 'Manglik'));
  ok('score is 0-100', m.score >= 0 && m.score <= 100, String(m.score));

  console.log('\n— tier —');
  ok('starts at 300 + completeness', cibilOf(uA) === 500, String(cibilOf(uA)));
  const before = cibilOf(uA);
  uA.stats.received = 10; uA.stats.replies = 9; uA.stats.chats = 10; uA.stats.completed = 8;
  ok('consistency lifts the tier', cibilOf(uA) > before, before + ' → ' + cibilOf(uA));
  uA.stats.received = 10; uA.stats.replies = 1;
  ok('ignoring people costs you', cibilOf(uA) < before + 120);
  const noSkips = cibilOf(uA);
  uA.stats.skips = 5;
  ok('skipping is a small deduction', noSkips - cibilOf(uA) === 10, String(noSkips - cibilOf(uA)));

  console.log('\n— block —');
  await api('POST', '/api/queue/join', { slot: 0 }, AT);
  await api('POST', '/api/queue/join', { slot: 0 }, BT);
  const st1 = await api('GET', '/api/state', null, AT);
  const cid = st1.json.slots.find(s => s.chatId)?.chatId;
  ok('matched before blocking', !!cid);
  const blocked = await api('POST', '/api/block', { id: uB.id, block: true }, AT);
  ok('block returns ok', blocked.status === 200 && blocked.json.blocked === true);
  const st2 = await api('GET', '/api/state', null, AT);
  ok('blocking ended the live chat', !st2.json.slots.some(s => s.chatId === cid));
  await api('POST', '/api/queue/join', { slot: 0 }, AT);
  await api('POST', '/api/queue/join', { slot: 0 }, BT);
  const st3 = await api('GET', '/api/state', null, AT);
  ok('blocked pair never matched again', !st3.json.slots.some(s => s.chatId));
  const un = await api('POST', '/api/block', { id: uB.id, block: false }, AT);
  ok('unblock works', un.json.blocked === false);
  await api('POST', '/api/queue/leave', { slot: 0 }, AT);
  await api('POST', '/api/queue/leave', { slot: 0 }, BT);

  console.log('\n— typing —');
  const t1 = await api('POST', '/api/chats/' + cid + '/typing', null, BT);
  ok('typing accepted', t1.status === 200);

  console.log('\n— legal pages —');
  for (const page of ['/terms', '/privacy', '/guidelines']) {
    const r = await fetch(base + page);
    const html = await r.text();
    ok(page + ' renders', r.status === 200 && html.includes('Milao') && html.length > 800, String(html.length));
  }

  console.log('\n— delete account —');
  const del = await api('DELETE', '/api/account', null, BT);
  ok('account deleted', del.status === 200 && del.json.deleted === true);
  ok('token dead afterwards', (await api('GET', '/api/me', null, BT)).status === 401);
  ok('user gone from the database', !Object.values(db().users).some(u => u.email === 'b@x.com'));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
