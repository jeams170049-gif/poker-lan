/* ===================== 맞고 (2~3인, 게임머니 전용) ===================== */
module.exports = function (ctx) {
  const { DB, byNick, sseSend, saveDB, avOfRec, pushLobby, evalHand } = ctx;
  /* --- 화투 48장 (hwatu.js 와 동일 구성) --- */
  const TY = { 1: ['광', '홍단', '피', '피'], 2: ['열끗', '홍단', '피', '피'], 3: ['광', '홍단', '피', '피'], 4: ['열끗', '초단', '피', '피'], 5: ['열끗', '초단', '피', '피'], 6: ['열끗', '청단', '피', '피'], 7: ['열끗', '초단', '피', '피'], 8: ['광', '열끗', '피', '피'], 9: ['열끗', '청단', '피', '피'], 10: ['열끗', '청단', '피', '피'], 11: ['광', '쌍피', '피', '피'], 12: ['광', '열끗', '띠', '쌍피'] };
  const HW = [];
  for (let m = 1; m <= 12; m++) TY[m].forEach((t, k) => {
    const c = { id: (m - 1) * 4 + k, month: m, kind: '피', pi: 0 };
    if (t === '광') { c.kind = '광'; if (m === 12) c.bi = true; }
    else if (t === '열끗') { c.kind = '열끗'; if ((m === 2 && k === 0) || (m === 4 && k === 0) || (m === 8 && k === 1)) c.bird = true; if (m === 9) c.choice = true; }
    else if (t === '홍단' || t === '초단' || t === '청단' || t === '띠') { c.kind = '띠'; c.ribbon = t; }
    else if (t === '쌍피') c.pi = 2;
    else c.pi = 1;
    HW.push(c);
  });
  const T_PLAY = 1300, T_FLIP = 1500, T_RESULT = 1900;   // 연출 시간(ms) — 더 느리게/빠르게 하려면 여기 숫자를 바꾸세요
  const KN = { '광': '광', '열끗': '열끗', '띠': '띠', '피': '피' };
  const cname = id => { const c = HW[id]; return c.month + '월 ' + (c.kind === '피' && c.pi === 2 ? '쌍피' : c.kind === '광' && c.bi ? '비광' : c.kind); };
  function anim(room, patch) { const g = room.g; g.animSeq = (g.animSeq || 0) + 1; g.anim = Object.assign({ by: g.t && g.t.nick }, g.anim || {}, patch, { seq: g.animSeq }); g.wait = { who: g.t.nick, kind: 'anim' }; g.deadline = Date.now() + 1000; broadcast(room); }
  function pause(room, ms, fn) { if (ctx.sync) return fn(); clearTimeout(room.timer); room.timer = setTimeout(() => { if (room.g && room.phase === 'play') fn(); }, ms); }
  const STAKES = [10000, 30000, 50000, 100000];
  const REQ = { 2: 7, 3: 5 };
  const rooms = new Map(), nickRoom = new Map();
  ['g1', 'g2', 'g3', 'g4'].forEach((id, i) => rooms.set(id, { id, name: '맞고 ' + (i + 1) + '번방', players: [], owner: null, phase: 'wait', log: [], g: null, timer: null, result: null, fx: null, fxN: 0 }));
  const chipsOf = n => (DB.players[n] && DB.players[n].chips) || 0;
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const err = m => ({ status: 200, obj: { err: m } }), ok = () => ({ status: 200, obj: { ok: true } });

  /* --- 점수 계산 --- */
  function calc(g, nick) {
    let gw = 0, bi = false, y = 0, d = 0, p = 0, bird = 0, hong = 0, cho = 0, cheong = 0;
    for (const id of g.cap[nick]) {
      const c = HW[id];
      if (c.kind === '광') { gw++; if (c.bi) bi = true; }
      else if (c.kind === '열끗') { if (c.choice && g.asPi[id]) p += 2; else { y++; if (c.bird) bird++; } }
      else if (c.kind === '띠') { d++; if (c.ribbon === '홍단') hong++; else if (c.ribbon === '초단') cho++; else if (c.ribbon === '청단') cheong++; }
      else p += c.pi;
    }
    const parts = {
      광: gw >= 5 ? 15 : gw === 4 ? 4 : gw === 3 ? (bi ? 2 : 3) : 0,
      열끗: (y >= 5 ? y - 4 : 0) + (bird === 3 ? 5 : 0),
      띠: (d >= 5 ? d - 4 : 0) + (hong === 3 ? 3 : 0) + (cho === 3 ? 3 : 0) + (cheong === 3 ? 3 : 0),
      피: p >= 10 ? p - 9 : 0
    };
    return { gw, y, d, p, parts, total: parts.광 + parts.열끗 + parts.띠 + parts.피 };
  }
  const goMul = n => n >= 3 ? Math.pow(2, n - 2) : 1, goAdd = n => Math.min(n, 2);

  /* --- 알림/로그 --- */
  function addLog(room, msg) { room.log.push(msg); if (room.log.length > 40) room.log.shift(); }
  function fx(room, nick, text) { room.fxN++; room.fx = { n: room.fxN, nick, text }; addLog(room, (nick ? nick + ': ' : '') + text); }
  function view(room, nick) {
    const g = room.g, inGame = g && room.phase !== 'wait';
    const v = {
      t: 'gs', id: room.id, name: room.name, phase: room.phase, owner: room.owner, me: nick,
      players: room.players.map(p => {
        const o = { nick: p.nick, av: avOfRec(DB.players[p.nick]), chips: chipsOf(p.nick), ready: !!p.ready, stake: p.stake || 0, online: !!(byNick.get(p.nick) && byNick.get(p.nick).res) };
        if (inGame && g.cap[p.nick]) {
          const sc = calc(g, p.nick), cp = { gw: [], y: [], d: [], p: [] };
          for (const id of g.cap[p.nick]) { const c = HW[id]; if (c.kind === '광') cp.gw.push(id); else if (c.kind === '열끗') (c.choice && g.asPi[id] ? cp.p : cp.y).push(id); else if (c.kind === '띠') cp.d.push(id); else cp.p.push(id); }
          Object.assign(o, { cap: cp, score: sc.total, parts: sc.parts, piv: sc.p, hand: g.hands[p.nick].length, go: g.goN[p.nick] || 0, mult: g.mult[p.nick] || 1, shook: g.shook[p.nick] || [], pp: g.ppeokN[p.nick] || 0 });
        }
        return o;
      }),
      applied: room.stakeApplied || 0, req: REQ[room.players.length] || 7, log: room.log.slice(-30), fx: room.fx, result: room.result
    };
    if (inGame) {
      Object.assign(v, { order: g.order, deck: g.deck.length, floor: g.floor, ppeok: g.ppeok, turn: g.order[g.turn], hand: g.hands[nick] || [], asPi: g.asPi, lastFlip: g.lastFlip, anim: g.anim || null });
      if (g.wait) v.wait = { who: g.wait.who, kind: g.wait.kind, cards: g.wait.cards || null, left: Math.max(0, Math.ceil((g.deadline - Date.now()) / 1000)) };
      if (g.pick) v.pick = { bundles: g.pick.bundles.map((b, i) => ({ taken: g.pick.taken[i] || null, cards: g.pick.revealed ? b : null })), revealed: g.pick.revealed, names: g.pick.names || null };
    }
    return v;
  }
  function broadcast(room) { for (const p of room.players) sseSend(byNick.get(p.nick), view(room, p.nick)); pushLobby(); }

  /* --- 방 --- */
  function join(sess, b) {
    if (sess.table || sess.seat) return err('포커/섯다 테이블에서 먼저 나오세요');
    const room = rooms.get(b.id); if (!room) return err('없는 방입니다');
    if (nickRoom.get(sess.nick)) return err('이미 맞고 방에 있어요');
    if (room.phase === 'wait' || room.phase === 'end') room.players.filter(p => !(byNick.get(p.nick) && byNick.get(p.nick).res)).forEach(p => leave(p.nick));
    if (room.players.length >= 3) return err('방이 가득 찼어요 (최대 3명)');
    if (room.phase !== 'wait' && room.phase !== 'end') return err('게임이 진행 중이에요. 끝난 뒤에 들어올 수 있어요');
    room.players.push({ nick: sess.nick, ready: false, stake: 0 }); nickRoom.set(sess.nick, room);
    if (!room.owner) room.owner = sess.nick;
    if (room.phase === 'end') { room.phase = 'wait'; room.result = null; }
    addLog(room, sess.nick + ' 님이 입장했어요'); broadcast(room); return ok();
  }
  function leave(nick, why) {
    const room = nickRoom.get(nick); if (!room) return;
    if ((room.phase === 'pick' || room.phase === 'play') && room.players.length > 1) forfeit(room, nick);
    const i = room.players.findIndex(p => p.nick === nick); if (i >= 0) room.players.splice(i, 1);
    nickRoom.delete(nick);
    sseSend(byNick.get(nick), { t: 'gsleft' });
    if (room.owner === nick) room.owner = room.players[0] ? room.players[0].nick : null;
    if (!room.players.length) { clearTimeout(room.timer); Object.assign(room, { phase: 'wait', g: null, result: null, log: [], stakeApplied: 0 }); }
    else { if (room.phase === 'end' || room.phase === 'wait') { room.phase = 'wait'; room.result = null; room.players.forEach(p => p.ready = false); } addLog(room, nick + ' 님이 나갔어요'); broadcast(room); }
    pushLobby();
  }
  function forfeit(room, nick) {
    const g = room.g; clearTimeout(room.timer);
    const others = room.players.filter(p => p.nick !== nick); const stake = room.stakeApplied || 10000;
    const pay = Math.min(chipsOf(nick), stake * 7), each = Math.floor(pay / others.length);
    DB.players[nick].chips -= each * others.length; others.forEach(p => DB.players[p.nick].chips += each); saveDB();
    room.result = { forfeit: nick, deltas: [{ nick, d: -each * others.length }, ...others.map(p => ({ nick: p.nick, d: each }))] };
    room.phase = 'end'; room.players.forEach(p => p.ready = false); fx(room, nick, '도중에 나가서 기권패!');
  }

  /* --- 시작 --- */
  function startGame(room) {
    const n = room.players.length, stakes = room.players.map(p => p.stake);
    room.stakeApplied = Math.min(...stakes); room.result = null;
    room.g = { order: room.players.map(p => p.nick), hands: {}, cap: {}, floor: [], deck: [], turn: 0, mult: {}, goN: {}, lastGo: {}, shook: {}, asPi: {}, ppeok: {}, ppeokN: {}, wait: null, t: {}, lastFlip: null, pick: null, stake: room.stakeApplied };
    room.g.order.forEach(nk => { room.g.cap[nk] = []; room.g.hands[nk] = []; room.g.mult[nk] = 1; room.g.goN[nk] = 0; room.g.lastGo[nk] = -1; room.g.shook[nk] = []; room.g.ppeokN[nk] = 0; });
    room.players.forEach(p => p.ready = false);
    room.phase = 'pick'; addLog(room, '── 새 게임 · 점당 ' + room.stakeApplied.toLocaleString() + '칩 ──'); newPick(room);
  }
  function newPick(room) {
    const g = room.g, deck = shuffle([...Array(20).keys()]);
    const toHw = id => { const m = Math.floor(id / 2) + 1, k = id % 2; return (m - 1) * 4 + k; };
    g.pick = { bundles: [0, 1, 2].map(i => [toHw(deck[i * 2]), toHw(deck[i * 2 + 1])]), taken: {}, revealed: false, names: null };
    g.pickDeadline = Date.now() + 15000; clearTimeout(room.timer); room.timer = setTimeout(() => autoPick(room), 15300); g.wait = { who: '*', kind: 'pick' }; g.deadline = g.pickDeadline; broadcast(room);
  }
  function autoPick(room) {
    const g = room.g; if (!g || !g.pick || g.pick.revealed) return;
    for (const nk of g.order) if (!Object.values(g.pick.taken).includes(nk)) { const free = [0, 1, 2].filter(i => !g.pick.taken[i]); doPick(room, nk, free[Math.floor(Math.random() * free.length)], true); }
  }
  function doPick(room, nick, i, silent) {
    const g = room.g; if (room.phase !== 'pick' || !g.pick || g.pick.revealed) return err('지금은 뽑을 수 없어요');
    if (!(i >= 0 && i < 3) || g.pick.taken[i]) return err('이미 뽑힌 패예요');
    if (Object.values(g.pick.taken).includes(nick)) return err('이미 뽑았어요');
    g.pick.taken[i] = nick;
    if (Object.keys(g.pick.taken).length < g.order.length) { broadcast(room); return ok(); }
    // 전원 뽑음 → 공개
    clearTimeout(room.timer); g.pick.revealed = true;
    const sc = []; for (const k of Object.keys(g.pick.taken)) { const b = g.pick.bundles[k]; const cv = id => ({ m: Math.floor(id / 4) + 1, k: id % 4 }); const h = evalHand(cv(b[0]), cv(b[1])); sc.push({ nick: g.pick.taken[k], s: h.s, name: h.name }); }
    g.pick.names = sc; sc.sort((a, b) => b.s - a.s);
    const tie = sc.length > 1 && sc[0].s === sc[1].s;
    addLog(room, '순서 뽑기: ' + sc.map(x => x.nick + ' ' + x.name).join(' / '));
    broadcast(room);
    room.timer = setTimeout(() => {
      if (tie) { fx(room, '', '최고 패가 동점! 다시 뽑아요'); newPick(room); }
      else { g.order = sc.map(x => x.nick); g.pick = null; deal(room); }
    }, 3500);
    return ok();
  }
  function deal(room) {
    const g = room.g, n = g.order.length, hc = n === 2 ? 10 : 7, fc = n === 2 ? 8 : 6;
    for (let tries = 0; tries < 50; tries++) {
      g.deck = shuffle([...Array(48).keys()]); g.floor = []; g.order.forEach(nk => g.hands[nk] = []);
      for (const nk of g.order) for (let i = 0; i < hc; i++) g.hands[nk].push(g.deck.pop());
      for (let i = 0; i < fc; i++) g.floor.push(g.deck.pop());
      const cnt = {}; g.floor.forEach(id => cnt[HW[id].month] = (cnt[HW[id].month] || 0) + 1);
      if (!Object.values(cnt).some(c => c >= 4)) break;
    }
    room.phase = 'play'; g.turn = 0; g.t = {};
    addLog(room, '패를 나눴어요 · 손 ' + hc + '장 / 바닥 ' + fc + '장 · ' + g.order[0] + ' 님이 선');
    // 총통
    for (const nk of g.order) { const cnt = {}; g.hands[nk].forEach(id => cnt[HW[id].month] = (cnt[HW[id].month] || 0) + 1); const m = Object.keys(cnt).find(k => cnt[k] === 4); if (m) { fx(room, nk, '총통! (' + m + '월 4장)'); return settle(room, nk, 10, '총통'); } }
    startTurn(room);
  }

  /* --- 턴 진행 --- */
  const floorOf = (g, m) => g.floor.filter(id => HW[id].month === m);
  const same = (a, b) => { const x = HW[a], y = HW[b]; return x.kind === y.kind && x.pi === y.pi && x.ribbon === y.ribbon && !!x.bi === !!y.bi && !!x.bird === !!y.bird && !x.choice && !y.choice; };
  function setWait(room, w, ms) { const g = room.g; g.wait = w; g.deadline = Date.now() + ms; clearTimeout(room.timer); room.timer = setTimeout(() => autoAct(room), ms + 300); broadcast(room); }
  function take(g, nick, ids) { for (const id of ids) { const i = g.floor.indexOf(id); if (i >= 0) g.floor.splice(i, 1); if (!g.cap[nick].includes(id)) g.cap[nick].push(id); } g.t.cap = true; (g.t.gain = g.t.gain || []).push(...ids); }
  function steal(room, nick, n) {
    const g = room.g; let got = 0;
    for (const o of g.order) { if (o === nick) continue; for (let i = 0; i < n; i++) {
      const pis = g.cap[o].filter(id => HW[id].kind === '피').sort((a, b) => HW[a].pi - HW[b].pi); if (!pis.length) break;
      const id = pis[0]; g.cap[o].splice(g.cap[o].indexOf(id), 1); g.cap[nick].push(id); got++; (g.t.stolenIds = g.t.stolenIds || []).push(id); } }
    return got;
  }
  function eatPpeok(room, nick, m) {
    const g = room.g; if (!g.ppeok[m]) return;
    const owner = g.ppeok[m]; delete g.ppeok[m];
    if (owner === nick) { steal(room, nick, 2); fx(room, nick, '자뻑! 피 2장씩 뺏기'); } else { steal(room, nick, 1); fx(room, nick, '뻑 먹기! 피 1장씩 뺏기'); }
  }
  function startTurn(room) {
    const g = room.g, nick = g.order[g.turn]; g.t = { hp: null, cap: false, nick, gain: [], stolenIds: [] }; g.anim = null;
    if (!g.hands[nick].length) { if (!g.deck.length) return endTurn(room); fx(room, nick, '손패가 없어 더미만 뒤집어요'); return setWait(room, { who: nick, kind: 'flip' }, 5000); }
    setWait(room, { who: nick, kind: 'hand' }, 30000);
  }
  function doPlay(room, nick, cid) {
    const g = room.g, w = g.wait; if (!w || w.kind !== 'hand' || w.who !== nick) return err('내 차례가 아니에요');
    const hand = g.hands[nick]; if (!hand.includes(cid)) return err('내 패가 아니에요');
    const M = HW[cid].month, t = g.t, sameN = hand.filter(id => HW[id].month === M).length, fl = floorOf(g, M);
    hand.splice(hand.indexOf(cid), 1); t.hand = cid;
    const tx = sameN === 3 && fl.length === 1 ? '💣 폭탄! 같은 월 3장을 한꺼번에 먹어요' : fl.length === 0 ? '바닥에 같은 월이 없어서 바닥에 내려놓아요' : fl.length === 1 ? '바닥의 같은 월 패와 짝이 맞아요!' : fl.length === 2 ? '바닥에 같은 월이 2장! 하나를 골라야 해요' : '바닥에 같은 월 3장(뻑 더미)! 전부 먹을 수 있어요';
    anim(room, { stage: 'play', hand: cid, deck: null, gain: null, stolen: 0, text: nick + ' 님이 ' + cname(cid) + ' 패를 냈어요 → ' + tx });
    pause(room, T_PLAY, () => doPlay2(room, nick, cid)); return ok();
  }
  function doPlay2(room, nick, cid) {
    const g = room.g, hand = g.hands[nick], M = HW[cid].month, t = g.t, sameH = [cid, ...hand.filter(id => HW[id].month === M)], fl = floorOf(g, M);
    if (sameH.length === 3 && fl.length === 1) {   // 폭탄
      const rest = sameH.filter(i => i !== cid); rest.forEach(i => hand.splice(hand.indexOf(i), 1));
      take(g, nick, [cid, ...rest, fl[0]]); g.mult[nick] *= 2; steal(room, nick, 1); fx(room, nick, '폭탄! (' + M + '월) 점수 ×2 · 피 1장씩 뺏기');
      t.hp = null; return flip(room);
    }
    if (fl.length === 3) { take(g, nick, [cid, ...fl]); eatPpeok(room, nick, M); t.hp = null; return flip(room); }
    if (fl.length === 2) {
      t.hp = { card: cid, partner: null };
      if (same(fl[0], fl[1])) { t.hp.partner = fl[0]; return flip(room); }
      return setWait(room, { who: nick, kind: 'choose', cards: fl, ctx: 'hand' }, 20000);
    }
    if (fl.length === 1) { t.hp = { card: cid, partner: fl[0] }; return flip(room); }
    g.floor.push(cid); t.hp = { card: cid, partner: null, placed: true }; return flip(room);
  }
  function doFlip(room, nick) { const g = room.g, w = g.wait; if (!w || w.kind !== 'flip' || w.who !== nick) return err('지금은 뒤집을 수 없어요'); g.t.hp = null; flip(room); return ok(); }
  function flip(room) {
    const g = room.g, t = g.t, nick = t.nick;
    if (!g.deck.length) return afterFlip(room);
    const D = g.deck.pop(); t.deck = D; g.lastFlip = D;
    const m0 = HW[D].month, hp0 = t.hp, fc = floorOf(g, m0).length;
    const tx = (hp0 && hp0.partner != null && HW[hp0.card].month === m0) ? '낸 패와 같은 월! 뻑인지 따닥인지 확인해요' : fc === 0 ? '바닥에 같은 월이 없어서 바닥에 놓여요' : fc === 1 ? '바닥의 같은 월 패와 짝이 맞아요!' : fc === 2 ? '바닥에 같은 월이 2장! 하나를 골라야 해요' : '바닥에 같은 월이 3장! 전부 먹어요';
    anim(room, { stage: 'flip', deck: D, gain: null, text: '더미에서 ' + cname(D) + ' 패를 뒤집었어요 → ' + tx });
    pause(room, T_FLIP, () => flipResolve(room, D));
  }
  function flipResolve(room, D) {
    const g = room.g, t = g.t, nick = t.nick, m = HW[D].month, hp = t.hp;
    if (hp && hp.partner != null && HW[hp.card].month === m) {
      const others = floorOf(g, m).filter(i => i !== hp.partner);
      if (!others.length) {                     // 뻑
        g.floor.push(hp.card, D); g.ppeok[m] = nick; g.ppeokN[nick]++; t.hp = null; fx(room, nick, '뻑! (' + m + '월 3장이 쌓였어요)');
        if (g.ppeokN[nick] >= 3) { fx(room, nick, '3번 뻑! 즉시 승리'); return settle(room, nick, REQ[g.order.length], '3뻑'); }
      } else { take(g, nick, [hp.card, hp.partner, ...others, D]); steal(room, nick, 1); t.hp = null; fx(room, nick, '따닥! 피 1장씩 뺏기'); }
      return afterFlip(room);
    }
    const fl = floorOf(g, m);
    if (fl.length === 0) g.floor.push(D);
    else if (fl.length === 1) { take(g, nick, [D, fl[0]]); if (hp && hp.placed && fl[0] === hp.card) { steal(room, nick, 1); fx(room, nick, '쪽! 피 1장씩 뺏기'); } }
    else if (fl.length === 2) { if (same(fl[0], fl[1])) take(g, nick, [D, fl[0]]); else return setWait(room, { who: nick, kind: 'choose', cards: fl, ctx: 'deck' }, 20000); }
    else { take(g, nick, [D, ...fl]); eatPpeok(room, nick, m); }
    return afterFlip(room);
  }
  function afterFlip(room) {
    const g = room.g, t = g.t, nick = t.nick;
    if (t.hp && t.hp.partner != null) take(g, nick, [t.hp.card, t.hp.partner]);
    const left = g.deck.length + g.order.reduce((s, k) => s + g.hands[k].length, 0);
    if (!g.floor.length && t.cap && left > 0) { steal(room, nick, 1); fx(room, nick, '싹쓸이! 피 1장씩 뺏기'); }
    const gain = [...(t.gain || [])], st = (t.stolenIds || []).length;
    anim(room, { stage: 'result', gain, stolen: st, text: gain.length ? gain.length + '장을 먹었어요' + (st ? ' (+ 상대 피 ' + st + '장 뺏음)' : '') : '먹은 패가 없어요 · 바닥에 남아요' });
    pause(room, T_RESULT, () => endTurn(room));
  }
  const allEmpty = g => !g.deck.length && g.order.every(k => !g.hands[k].length);
  function endTurn(room) {
    const g = room.g, nick = g.t.nick || g.order[g.turn], sc = calc(g, nick), req = REQ[g.order.length];
    const can = sc.total >= req && sc.total > g.lastGo[nick];
    if (can) { if (allEmpty(g)) return settle(room, nick); return setWait(room, { who: nick, kind: 'go' }, 25000); }
    if (allEmpty(g)) return exhaust(room);
    nextTurn(room);
  }
  function nextTurn(room) { const g = room.g; g.turn = (g.turn + 1) % g.order.length; startTurn(room); }
  function exhaust(room) {
    const g = room.g, gos = g.order.filter(k => g.goN[k] > 0);
    if (gos.length) { gos.sort((a, b) => calc(g, b).total - calc(g, a).total); return settle(room, gos[0]); }
    clearTimeout(room.timer); room.phase = 'end'; room.result = { draw: true }; g.wait = null; fx(room, '', '모두 소진! 승부를 못 가려 나가리'); room.players.forEach(p => p.ready = false); broadcast(room);
  }
  function autoAct(room) {
    const g = room.g; if (!g || !g.wait) return; const w = g.wait;
    if (w.kind === 'pick') return autoPick(room);
    if (w.kind === 'hand') { const hand = g.hands[w.who], fl = g.floor.map(id => HW[id].month); return doPlay(room, w.who, hand.find(id => fl.includes(HW[id].month)) ?? hand[0]); }
    if (w.kind === 'flip') return doFlip(room, w.who);
    if (w.kind === 'choose') return doChoose(room, w.who, w.cards[0]);
    if (w.kind === 'go') return doStop(room, w.who);
  }
  function doChoose(room, nick, card) {
    const g = room.g, w = g.wait; if (!w || w.kind !== 'choose' || w.who !== nick || !w.cards.includes(card)) return err('선택할 수 없어요');
    if (w.ctx === 'hand') { g.t.hp.partner = card; flip(room); }
    else { take(g, nick, [g.t.deck, card]); afterFlip(room); }
    return ok();
  }
  function doGo(room, nick) { const g = room.g, w = g.wait; if (!w || w.kind !== 'go' || w.who !== nick) return err('지금은 고를 할 수 없어요'); g.goN[nick]++; g.lastGo[nick] = calc(g, nick).total; fx(room, nick, g.goN[nick] + '고!'); nextTurn(room); return ok(); }
  function doStop(room, nick) { const g = room.g, w = g.wait; if (!w || w.kind !== 'go' || w.who !== nick) return err('지금은 스톱할 수 없어요'); fx(room, nick, '스톱!'); settle(room, nick); return ok(); }

  /* --- 정산 --- */
  function settle(room, winner, baseOverride, note) {
    const g = room.g; clearTimeout(room.timer); g.wait = null;
    const sc = calc(g, winner), special = baseOverride != null;
    const gn = g.goN[winner], base = (special ? baseOverride : sc.total + goAdd(gn)) * (special ? 1 : goMul(gn)) * (g.mult[winner] || 1);
    const losers = g.order.filter(k => k !== winner), rows = [];
    for (const L of losers) {
      const cl = calc(g, L), tags = [];
      let m = 1;
      if (!special) {
        if (sc.p >= 10 && cl.p <= 5) { m *= 2; tags.push('피박'); }
        if (sc.gw >= 3 && cl.gw === 0) { m *= 2; tags.push('광박'); }
        if (sc.y >= 7) { m *= 2; tags.push('멍박'); }
      }
      rows.push({ nick: L, pts: base * m, tags, go: g.goN[L] > 0 });
    }
    const gobak = rows.find(r => r.go);
    const deltas = {}; deltas[winner] = 0;
    const pay = (from, amt) => { const a = Math.min(amt, chipsOf(from)); DB.players[from].chips -= a; DB.players[winner].chips += a; deltas[from] = (deltas[from] || 0) - a; deltas[winner] += a; };
    if (gobak && !special) { const total = rows.reduce((s, r) => s + r.pts, 0); gobak.tags.push('고박'); pay(gobak.nick, total * g.stake); rows.forEach(r => { if (r !== gobak) deltas[r.nick] = 0; }); }
    else rows.forEach(r => pay(r.nick, r.pts * g.stake));
    const rw = DB.players[winner]; rw.wins = (rw.wins || 0) + 1; g.order.forEach(k => { DB.players[k].hands = (DB.players[k].hands || 0) + 1; });
    saveDB();
    room.result = { winner, note: note || '', base, goN: gn, mult: g.mult[winner] || 1, parts: sc.parts, rows, deltas: g.order.map(k => ({ nick: k, d: deltas[k] || 0 })), stake: g.stake };
    room.phase = 'end'; room.players.forEach(p => p.ready = false);
    addLog(room, winner + ' 승리! ' + base + '점' + (rows.some(r => r.tags.length) ? ' (' + rows.filter(r => r.tags.length).map(r => r.nick + ' ' + r.tags.join('·')).join(', ') + ')' : ''));
    broadcast(room);
  }

  /* --- API --- */
  function handle(sess, b) {
    const nick = sess.nick, a = b.a;
    if (a === 'join') return join(sess, b);
    const room = nickRoom.get(nick); if (!room) return err('맞고 방에 들어와 있지 않아요');
    const me = room.players.find(p => p.nick === nick);
    if (a === 'leave') { leave(nick); return ok(); }
    if (a === 'stake') {
      if (room.phase !== 'wait' && room.phase !== 'end') return err('지금은 바꿀 수 없어요');
      const v = +b.v; if (!STAKES.includes(v)) return err('금액이 올바르지 않아요');
      if (chipsOf(nick) < v * 10) return err('칩이 부족해요 (점당 금액의 10배 이상 필요)');
      me.stake = v; broadcast(room); return ok();
    }
    if (a === 'ready') {
      if (room.phase !== 'wait' && room.phase !== 'end') return err('이미 진행 중이에요');
      if (!me.stake) return err('먼저 점당 금액을 고르세요'); me.ready = !me.ready; broadcast(room); return ok();
    }
    if (a === 'start') {
      if (room.owner !== nick) return err('방장만 시작할 수 있어요');
      if (room.phase !== 'wait' && room.phase !== 'end') return err('이미 진행 중이에요');
      if (room.players.length < 2) return err('2명 이상 필요해요');
      if (!me.stake) return err('먼저 점당 금액을 고르세요');
      const no = room.players.find(p => !p.ready && p.nick !== nick); if (no) return err(no.nick + ' 님이 아직 준비하지 않았어요');
      const ap = Math.min(...room.players.map(p => p.stake));
      const poor = room.players.find(p => chipsOf(p.nick) < ap * 10); if (poor) return err(poor.nick + ' 님의 칩이 부족해요');
      room.phase = 'wait'; startGame(room); return ok();
    }
    if (room.phase === 'wait' || room.phase === 'end') return err('게임 중이 아니에요');
    const g = room.g;
    if (a === 'pick') return doPick(room, nick, +b.i);
    if (a === 'play') return doPlay(room, nick, +b.card) || ok();
    if (a === 'choose') return doChoose(room, nick, +b.card);
    if (a === 'flip') return doFlip(room, nick);
    if (a === 'go') return doGo(room, nick);
    if (a === 'stop') return doStop(room, nick);
    if (a === 'shake') {
      const w = g.wait, m = +b.m; if (!w || w.kind !== 'hand' || w.who !== nick) return err('내 차례에만 흔들 수 있어요');
      if (g.shook[nick].includes(m)) return err('이미 흔들었어요');
      if (g.hands[nick].filter(id => HW[id].month === m).length !== 3) return err('같은 월 3장이 있어야 해요');
      if (floorOf(g, m).length) return err('바닥에 같은 월이 있으면 폭탄이에요! 그냥 내세요');
      g.shook[nick].push(m); g.mult[nick] *= 2; fx(room, nick, '흔들기! (' + m + '월 3장 공개) 점수 ×2'); broadcast(room); return ok();
    }
    if (a === 'toggle9') {
      const id = 9 * 4 - 4; if (!g.cap[nick] || !g.cap[nick].includes(id)) return err('9월 열끗이 없어요');
      g.asPi[id] = !g.asPi[id]; broadcast(room); return ok();
    }
    return err('알 수 없는 동작');
  }
  const list = () => [...rooms.values()].map(r => ({ id: r.id, name: r.name, count: r.players.length, phase: r.phase, players: r.players.map(p => p.nick), stake: r.stakeApplied || 0 }));
  const inRoom = n => !!nickRoom.get(n);
  function resync(nick) { const r = nickRoom.get(nick); if (r) sseSend(byNick.get(nick), view(r, nick)); }
  function onDisc(nick) { setTimeout(() => { const s = byNick.get(nick); const r = nickRoom.get(nick); if (r && (!s || !s.res) && (r.phase === 'wait' || r.phase === 'end')) leave(nick); }, 20000); }
  return { handle, list, inRoom, resync, onDisc, _rooms: rooms, _HW: HW, _calc: calc };
};
