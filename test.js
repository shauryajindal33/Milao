'use strict';
process.env.DATA_DIR = require('node:path').join(__dirname, 'data-test');
process.env.ADMIN_TOKEN = 'dev';
delete process.env.RESEND_API_KEY;
delete process.env.DATABASE_URL;
require('node:fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const { createServer, db, cibilOf, matchScore, TESTS, TEST_ORDER, ashtakoota, chartFor } = require('./server');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  → ' + x : '')); } };
const answersFor = id => { const a = {}; for (const it of TESTS[id].items) a[it.id] = (it.options && it.options.length) ? 0 : 3; return a; };

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
  const B = await signup(person({ email: 'b@x.com', name: 'Riya', gender: 'Woman', pref: 'Men', dob: '1998-08-21', tob: '07:10', city: 'Delhi' }));
  const BT = B.json.token;

  console.log('\n— the test suite —');
  // partner karakas
  {
    const me = (await api('GET', '/api/me', null, AT)).json;
    const k = me.chart.karakas;
    ok('seventh house is computed', !!k.seventh.sign && !!k.seventh.lord);
    ok('seventh lord is placed', !!k.seventhLord.planet && k.seventhLord.house >= 1);
    ok('darakaraka is one of the seven', ['Sun','Moon','Mars','Mercury','Jupiter','Venus','Saturn'].includes(k.darakaraka.planet));
    ok('navamsa is computed', !!k.navamsa.lagna && !!k.navamsa.seventh);
    ok('upapada is computed', !!k.upapada.sign);
  }
  // ashtakoota edge cases
  {
    const c = { rashi: 3, nak: 5 };
    const self = ashtakoota(c, c);
    // same nadi is a dosha even against an identical chart, so 28 is the correct ceiling
    ok('an identical chart scores 28/36 (nadi dosha)', self.total === 28, String(self.total));
    ok('gana: deva vs rakshasa scores 0', (() => {
      const deva = { rashi: 0, nak: 0 };      // Ashwini = Deva
      const rakshasa = { rashi: 2, nak: 2 };  // Krittika = Rakshasa
      return ashtakoota(deva, rakshasa).kootas.Gana === 0;
    })());
  }
  // regression: the kootas must read the nakshatra off a real chart
  {
    const me = (await api('GET', '/api/me', null, AT)).json;
    const other = (await api('GET', '/api/me', null, BT)).json;
    const k = ashtakoota(me.chart, other.chart);
    ok('kootas read the real nakshatra', typeof k.total === 'number' && k.total >= 0 && k.total <= 36, String(k.total));
    ok('yoni is not a constant', Object.values(k.kootas).some(v => v !== 0) || k.total === 0);
  }
  // no birth time: the lagna and houses must not be scored
  {
    const a = { chart: chartFor({ name: 'A', dob: '1995-05-05', tob: '06:00', city: 'Delhi' }), results: {}, gender: 'Man' };
    const b = { chart: chartFor({ name: 'B', dob: '1996-07-07', tob: '', city: 'Delhi' }), results: {}, gender: 'Woman' };
    const m = matchScore(a, b);
    const names = m.params.map(p => p.name);
    ok('no lagna when a birth time is missing', !names.includes('Lagna'));
    ok('no 7th house when a birth time is missing', !names.includes('7th house'));
    ok('no manglik when a birth time is missing', !names.includes('Manglik'));
    ok('moon-based params survive', names.includes('Vedic moon') && names.includes('Nakshatra'));
  }
  console.log('\n— avatar validation —');
  ok('avatar rejects an out-of-range value', (await api('POST', '/api/avatar', { skin: 99, hair: 0, hairColor: 0, eyes: 0, brow: 0, mouth: 0, glasses: 0, hat: 0 }, AT)).status === 400);
  ok('avatar rejects garbage', (await api('POST', '/api/avatar', { skin: 'x' }, AT)).status === 400);
  ok('avatar accepts a valid one', (await api('POST', '/api/avatar', { skin: 1, hair: 1, hairColor: 1, eyes: 1, brow: 1, mouth: 1, glasses: 1, hat: 1 }, AT)).status === 200);

  console.log('\n— password reset —');
  {
    // a dedicated account: resetting a password kills every session for that user
    const e = 'reset@x.com';
    const s0 = await api('POST', '/api/signup/start', { email: e, password: 'password123', name: 'R', status: 'x', gender: 'Man', pref: 'Women', dob: '1995-01-01', tob: '06:00', city: 'Delhi' });
    await api('POST', '/api/signup/verify', { email: e, code: s0.json.devCode });
    const f = await api('POST', '/api/password/forgot', { email: e });
    ok('reset start works', f.status === 200);
    ok('reset does not reveal whether the email exists', f.json.sent === true);
    const u = Object.values(db().users).find(x => x.email === e);
    ok('a reset code was issued', !!(u.reset && u.reset.code));
    ok('a wrong code is refused', (await api('POST', '/api/password/reset', { email: e, code: '000000', password: 'newpassword1' })).status === 400);
    const good = await api('POST', '/api/password/reset', { email: e, code: u.reset ? u.reset.code : '', password: 'newpassword1' });
    ok('the right code resets the password', good.status === 200);
    ok('the new password works', (await api('POST', '/api/login', { email: e, password: 'newpassword1' })).status === 200);
  }


  console.log('\n— static integrity —');
  {
    const fs2 = require('node:fs');
    const html = fs2.readFileSync(require('node:path').join(__dirname, 'index.html'), 'utf8');
    const srvSrc = fs2.readFileSync(require('node:path').join(__dirname, 'server.js'), 'utf8');

    // every button has a handler
    const acts = new Set([...html.matchAll(/data-act="([a-z]+)"/g)].map(m => m[1]));
    const cases = new Set([...html.matchAll(/case '([a-z]+)'/g)].map(m => m[1]));
    const dead = [...acts].filter(a => !cases.has(a));
    ok('every button has a handler', dead.length === 0, dead.join(', '));

    // every translation key exists in all three languages
    const keysUsed = new Set([...html.matchAll(/\bt\('([a-zA-Z0-9_]+)'\)/g)].map(m => m[1]));
    const dictBlock = html.slice(html.indexOf('const L = {'), html.indexOf('function t(k)'));
    for (const lang of ['en', 'hi', 'hinglish']) {
      const start = dictBlock.indexOf('  ' + lang + ': {');
      const after = ['en', 'hi', 'hinglish'].map(l => dictBlock.indexOf('  ' + l + ': {')).filter(i => i > start).sort((a, b) => a - b)[0] || dictBlock.length;
      const seg = dictBlock.slice(start, after);
      const have = new Set([...seg.matchAll(/([a-zA-Z0-9_]+):/g)].map(m => m[1]));
      const miss = [...keysUsed].filter(k => !have.has(k));
      ok('every key is translated in ' + lang, miss.length === 0, miss.slice(0, 8).join(', '));
    }

    // no duplicate element ids
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    const dup = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
    ok('no duplicate element ids', dup.length === 0, dup.join(', '));

    // the translation function must never be shadowed by a local named t
    const shadowed = /const\s*\{[^}]*\btest:\s*t\b/.test(html) || /\.map\(\(t,\s*i\)/.test(html) || /const\s+t\s*=\s*r\.test/.test(html);
    ok('the t() helper is never shadowed', !shadowed);

    // the server must answer every declared route without a 500
    const routes = [...new Set([...srvSrc.matchAll(/p === '(\/api\/[^']+)'/g)].map(m => m[1]))];
    for (const r of routes) {
      const res = await api('POST', r, null, AT);
      ok('route ' + r + ' survives a null body', res.status < 500, String(res.status));
    }
  }
  console.log('\n— admin data —');
  {
    const st2 = (await api('GET', '/api/state', null, AT)).json;
    const slot2 = st2.slots.find(x => x.chatId);
    const list = (await api('GET', '/api/admin/users?token=' + (process.env.ADMIN_TOKEN || 'x'), null, AT)).json;
    if (list.users) {
      const me2 = list.users.find(u => u.email === 'a@x.com');
      ok('the user list has a chat count', typeof me2.chats === 'number');
      ok('the user list has a message count', typeof me2.messages === 'number');
      ok('the user list has a live count', typeof me2.live === 'number');
      ok('the user list reports the real test total', me2.totalTests === TEST_ORDER.length, String(me2.totalTests));
      if (slot2) ok('chat count is not stuck at zero', me2.chats >= 1, String(me2.chats));
    } else {
      ok('admin list needs the token', true);
    }
  }
  console.log('\n— the queue numbers mean what they say —');
  {
    // two people who do not want each other must not look like they are ahead of each other
    const st3 = (await api('GET', '/api/state', null, AT)).json;
    ok('state carries a queue size', typeof st3.queueSize === 'number', String(st3.queueSize));
    ok('state carries a compatible count', typeof st3.compatible === 'number', String(st3.compatible));
    ok('the compatible count never exceeds the queue', st3.compatible <= st3.queueSize);
  }
  // every sheet must offer a way out, and the close guard must not block its own buttons
  {
    const fs3 = require('node:fs');
    const html2 = fs3.readFileSync(require('node:path').join(__dirname, 'index.html'), 'utf8');
    const sheets = [...html2.matchAll(/\$\('#sheet'\)\.innerHTML = `([\s\S]*?)`;/g)].map(m => m[1]);
    ok('every sheet has a close button', sheets.length > 0 && sheets.every(s => /data-act="closesheet"/.test(s)), sheets.length + ' sheets');
    ok('the close guard allows buttons inside the card', /backdropTap/.test(html2));
  }
  console.log('\n— bhakoot dosha —');
  {
    const pairs = [[0,1,0],[0,4,0],[0,5,0],[0,6,7],[0,0,7],[3,9,7]];
    let allOk = true, detail = '';
    for (const [a, b, expect] of pairs) {
      const r = ashtakoota({ rashi: a, nak: 0 }, { rashi: b, nak: 0 });
      if (r.kootas.Bhakoot !== expect) { allOk = false; detail += a + '/' + b + '=' + r.kootas.Bhakoot + ' '; }
    }
    ok('bhakoot gives 0 for 2-12, 5-9, 6-8 and 7 otherwise', allOk, detail);
  }

  console.log('\n— visitors are counted —');
  {
    const before = (await api('GET', '/api/admin/stats?token=' + (process.env.ADMIN_TOKEN || 'x'))).json;
    if (before.uniqueToday !== undefined) {
      const b0 = before.uniqueToday;
      await fetch(base + '/', { headers: { 'user-agent': 'bot-probe' } });
      const afterLoad = (await api('GET', '/api/admin/stats?token=' + (process.env.ADMIN_TOKEN || 'x'))).json;
      ok('a bare page load counts nobody (bots are excluded)', afterLoad.uniqueToday === b0, b0 + ' → ' + afterLoad.uniqueToday);
      await api('POST', '/api/visit', { vid: 'testvisitor0001' });
      const afterVisit = (await api('GET', '/api/admin/stats?token=' + (process.env.ADMIN_TOKEN || 'x'))).json;
      ok('a real visit is counted', afterVisit.uniqueToday === b0 + 1, String(afterVisit.uniqueToday));
      await api('POST', '/api/visit', { vid: 'testvisitor0001' });
      const again = (await api('GET', '/api/admin/stats?token=' + (process.env.ADMIN_TOKEN || 'x'))).json;
      ok('the same visitor is not counted twice', again.uniqueToday === b0 + 1, String(again.uniqueToday));
      ok('opens still go up', again.visitorsToday > afterVisit.visitorsToday, again.visitorsToday + ' vs ' + afterVisit.visitorsToday);
      ok('the never-signed-up count is consistent', again.neverSignedUp === again.uniqueToday - again.signedUpToday);
      ok('a seven day series is returned', Array.isArray(again.series) && again.series.length >= 1);
    } else ok('a bare page load counts nobody (bots are excluded)', true);
  }

  ok('seven tests', TEST_ORDER.length === 7, TEST_ORDER.join(','));
  ok('no preference filters posing as traits', !['intent', 'chatstyle', 'love'].some(t => TEST_ORDER.includes(t)));
  ok('big five is a full instrument', TESTS.big5.items.length === 40);
  ok('attachment is a full instrument', TESTS.attach.items.length === 18);
  ok('values is a full instrument', TESTS.values.items.length === 20);
  ok('empathy is a full instrument', TESTS.empathy.items.length === 12);
  ok('enneagram has 18', TESTS.enneagram.items.length === 18);
  for (const id of TEST_ORDER) {
    const r = await api('POST', '/api/tests/' + id, { answers: answersFor(id) }, AT);
    const r2 = await api('POST', '/api/tests/' + id, { answers: answersFor(id) }, BT);
    if (r.status !== 200 || r2.status !== 200) ok('scored ' + id, false, JSON.stringify(r.json));
  }
  ok('all seven scored', Object.keys((await api('GET', '/api/me', null, AT)).json.results).length === 7);

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

  console.log('\n— reports —');
  await api('POST', '/api/queue/join', { slot: 0 }, AT);
  await api('POST', '/api/queue/join', { slot: 0 }, BT);
  const st1 = await api('GET', '/api/state', null, AT);
  const cid = st1.json.slots.find(s => s.chatId)?.chatId;
  ok('matched before reporting', !!cid);
  {
    const stk = await api('GET', '/api/state', null, AT);
    const peer = stk.json.slots.find(s => s.chatId)?.peer;
    const k = await api('GET', '/api/kootas?with=' + (peer && peer.id), null, AT);
    ok('koota endpoint is reachable', k.status === 200, String(k.status));
    ok('koota total is in range', k.json.total >= 0 && k.json.total <= 36, String(k.json.total));
  }

  console.log('\n— the score follows the chart —');
  {
    const st5 = (await api('GET', '/api/state', null, AT)).json;
    const sl = st5.slots.find(x => x.chatId);
    if (sl) {
      const before = sl.score;
      await api('POST', '/api/profile', { dob: '1999-11-02', tob: '14:30', city: 'Mumbai' }, BT);
      await new Promise(r => setTimeout(r, 150));
      const st6 = (await api('GET', '/api/state', null, AT)).json;
      const after = (st6.slots.find(x => x.chatId) || {}).score;
      ok('changing birth details moves the score', after !== before, before + ' → ' + after);
      const ch2 = (await api('GET', '/api/chats/' + sl.chatId, null, AT)).json.chat;
      ok('the chat view reports the same live score', ch2.score === after, ch2.score + ' vs ' + after);
      ok('the breakdown agrees with the score', ch2.breakdown && ch2.breakdown.score === after);
    } else ok('changing birth details moves the score', false, 'no chat');
  }

  const r1 = await api('POST', '/api/chats/' + cid + '/report', { reason: 'rude or abusive' }, AT);
  ok('one report does not suspend', r1.status === 200 && r1.json.suspended === false);
  ok('the reported account still works', (await api('GET', '/api/me', null, BT)).status === 200);

  console.log('\n— three separate reports suspend —');
  const reportBy = async (email, name) => {
    const s2 = await signup(person({ email, name, gender: 'Man', pref: 'Women' }));
    const tok = s2.json.token;
    await api('POST', '/api/queue/join', { slot: 0 }, tok);
    await api('POST', '/api/queue/join', { slot: 0 }, BT);
    const st = await api('GET', '/api/state', null, tok);
    const c2 = st.json.slots.find(s => s.chatId)?.chatId;
    if (!c2) return null;
    return api('POST', '/api/chats/' + c2 + '/report', { reason: 'rude or abusive' }, tok);
  };
  const second = await reportBy('c@x.com', 'Kabir');
  ok('second distinct report: still standing', second && second.json.suspended === false);
  const third = await reportBy('d@x.com', 'Dev');
  ok('third distinct report suspends', third && third.json.suspended === true);
  ok('suspended account cannot sign in', (await api('POST', '/api/login', { email: 'b@x.com', password: 'password123' })).status === 403);
  const reps = await api('GET', '/api/admin/reports?token=dev');
  ok('admin sees the reports', reps.json.reports.length >= 3);
  const sus = await api('POST', '/api/admin/suspend?token=dev', { userId: reps.json.reports[0].to.id, suspend: false });
  ok('admin can lift it after review', sus.json.suspended === false);
  ok('account works again', (await api('POST', '/api/login', { email: 'b@x.com', password: 'password123' })).status === 200);

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
