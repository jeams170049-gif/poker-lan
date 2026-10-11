'use strict';
/* =====================================================================
   포커 LAN 서버 (텍사스 홀덤 + 섯다)  —  외부 패키지 없이 Node.js만으로 동작
   실행:  node server.js     →  같은 와이파이의 기기에서  http://<이 PC의 IP>:3000
   ===================================================================== */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const SPEED = +process.env.POKER_SPEED || 1;                       // 테스트용 시간 배속
const DATA_DIR = process.env.POKER_DATA || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'players.json');
const PUB = path.join(__dirname, 'public');

const REFILL_WAIT = 5 * 60 * 1000;
const START_CHIPS = 1000000, REFILL_TO = 200000, REFILL_BELOW = 20000, MAXSEATS = 7;
const SB = 5000, BB = 10000;           // 홀덤 블라인드
const ANTE = 10000, RAISE_CAP = 4;     // 섯다 판돈 / 한 라운드 최대 
레이즈 횟수

const sleep = ms => new Promise(r => setTimeout(r, ms / SPEED));
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const hash = s => crypto.createHash('sha256').update('poker-lan:' + s).digest('hex');

/* ===================== 저장소 (닉네임별 칩 · 전적) ===================== */
let DB = { players: {} };
try { DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); if (!DB.players) DB.players = {}; } catch (e) { 
}
let dirty = false;
const saveDB = () => { dirty = true; };
function flushDB() {
  if (!dirty) return; dirty = false;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(DB)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); }
  catch (e) { console.error('저장 실패:', e.message); }
}
const dbTimer = setInterval(flushDB, 2000); dbTimer.unref && dbTimer.unref();

/* ===================== 세션 ===================== 
*/
const sessions = new Map();   // token -> sess
const byNick = new Map();     // nick  -> sess
const seated = new Map();     // nick  -> seat (앉아 있거나 정산 대기중)
const chipsOf = nick => { const s = seated.get(nick); return s ? s.chips : (DB.players[nick] ? DB.players[nick].chips : 0); };
function sseSend(sess, obj) { if (!sess || !sess.res) return; try { sess.res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { } }

/* ===================== 홀덤 평가 ===================== */
const FULL = []; for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) FULL.push({ r, s, id: r * 4 + s });
function eval5(c) {
  const r = c.map(x => x.r).sort((a, b) => b - 
a);
  const flush = c.every(x => x.s === c[0].s);
  const cnt = {}; r.forEach(x => cnt[x] = (cnt[x] || 0) + 1);
  const g = Object.entries(cnt).map(([k, v]) => [+k, v]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const u = [...new Set(r)]; let sh = 0;
  if (u.length === 5) { if (u[0] - u[4] === 4) sh = u[0]; else if (u[0] === 14 && u[1] === 5) sh = 5; }
  let cat, tb;
  if (sh && flush) { cat = 8; tb = [sh]; }
  else if (g[0][1] === 4) { cat = 7; tb = [g[0][0], g[1][0]]; }
  else if (g[0][1] === 3 && g[1] && g[1][1] === 2) { cat = 6; tb = [g[0][0], g[1][0]]; }
  else if (flush) { cat = 5; tb = r; 
}
  else if (sh) { cat = 4; tb = [sh]; }
  else if (g[0][1] === 3) { cat = 3; tb = g.map(x => x[0]); }
  else if (g[0][1] === 2 && g[1][1] === 2) { cat = 2; tb = g.map(x => x[0]); }
  else if (g[0][1] === 2) { cat = 1; tb = g.map(x => x[0]); }
  else { cat = 0; tb = r; }
  let s = cat; for (let i = 0; i < 5; i++) s = s * 15 + (tb[i] || 0);
  return s;
}
const COMBOS7 = (() => { const out = []; for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) { const idx = []; for (let i = 0; i < 7; i++) if (i !== a && i !== b) idx.push(i); out.push(idx); } return out; })();
function best7(cards) 
{
  if (cards.length === 5) return { score: eval5(cards), cards };
  let m = -1, bc = null;
  const sets = [];
  if (cards.length === 7) for (const ix of COMBOS7) sets.push(ix.map(i => cards[i]));
  else if (cards.length === 6) for (let a = 0; a < 6; a++) sets.push(cards.filter((_, i) => i !== a));
  else sets.push(cards);
  for (const c of sets) { const s = eval5(c); if (s > m) { m = s; bc = c; } }
  return { score: m, cards: bc };
}
const bestScore = cards => best7(cards).score;
function handName(s) 
{
  const cat = Math.floor(s / 759375), hi = Math.floor(s / 50625) % 15;
  switch (cat) {
    case 8: return hi === 14 ? '로열 스트레이트 플러시' : '스트레이트 플러시';
    case 7: return '포카드'; case 6: return '풀하우스'; case 5: return '플러시';
    case 4: return hi === 14 ? '마운틴' : hi === 5 ? '백스트레이트' : '스트레이트';
    case 3: return '트리플'; case 2: return '투페어'; case 1: return '원페어'; default: return '하이카드';
  }
}

/* ===================== 섯다 평가 ===================== */
const CARDS = []; for (let m = 1; m <= 10; m++) for (let k = 0; k < 2; k++) CARDS.push({ id: (m - 1) * 2 + k, m, k });
const TYPE = { 1: ['광', '띠'], 2: ['열', '띠'], 3: ['광', '띠'], 4: ['열', '띠'], 5: ['열', '띠'], 6: ['열', '띠'], 7: ['열', '띠'], 8: ['광', '열'], 9: ['열', '띠'], 10: ['열', '띠'] };
const typ = c => TYPE[c.m][c.k], isG = c => typ(c) === '광', isY = c => typ(c) === '열';
function evalHand(a, b) {
  const x = Math.min(a.m, b.m), y = Math.max(a.m, b.m);
  const gw = isG(a) && isG(b);
  if (gw && x === 3 && y === 8) return { s: 1000, name: '38광땡', tag: 'g38' 
};
  if (gw && x === 1 && y === 8) return { s: 900, name: '18광땡', tag: 'g18' };
  if (gw && x === 1 && y === 3) return { s: 800, name: '13광땡', tag: 'g13' };
  if (x === y) return { s: 500 + x, name: x === 10 ? '장땡' : x + '땡', tag: 'ddaeng', n: x };
  const SP = { 102: [306, '알리'], 104: [305, '독사'], 109: [304, '구삥'], 110: [303, '장삥'], 410: [302, '장사'], 406: [301, '세륙'] };
  const key = x * 100 + y;
  if (SP[key]) return { s: SP[key][0], name: SP[key][1], tag: 'sp' };
  const k = (x + y) % 10;
  const o = { s: 100 + k, name: k === 0 ? '망통' : k === 9 ? '갑오' : k + '끗', tag: 'kkut' 
};
  if (x === 4 && y === 9) { o.tag = (isY(a) && isY(b)) ? 'mgusa' : 'gusa'; o.name = o.tag === 'mgusa' ? '멍텅구리구사' : '구사'; }
  else if (x === 4 && y === 7 && isY(a) && isY(b)) { o.tag = 'amhaeng'; o.name = '암행어사'; }
  else if (x === 3 && y === 7 && (isG(a) || isG(b)) && (isY(a) || isY(b))) { o.tag = 'ddaejabi'; o.name = '땡잡이'; }
  return o;
}
function resolve(L) {   // L: [{i,h}]
  const maxB = Math.max(...L.map(o => o.h.s));
  if (L.some(o => o.h.tag === 'mgusa') && maxB <= 509) return { type: 're', why: '멍텅구리구사' };
  if (L.some(o => o.h.tag === 'gusa') && maxB <= 306) return { type: 
're', why: '구사' };
  const hasG = L.some(o => o.h.tag === 'g18' || o.h.tag === 'g13');
  const hasD = L.some(o => o.h.tag === 'ddaeng' && o.h.n <= 9);
  L.forEach(o => {
    o.e = o.h.s;
    if (o.h.tag === 'amhaeng' && hasG) o.e = 950;
    if (o.h.tag === 'ddaejabi' && hasD) o.e = 509.5;
  });
  const m = Math.max(...L.map(o => o.e)), w = L.filter(o => o.e === m);
  if (w.length > 1) return { type: 're', why: '무승부', who: w.map(o => o.i) };
  return { type: 'win', w: w.map(o => o.i) };
}
function bestPair(idsOrCards) {          // 카드 id 배열 → {h, pair:[a,b](인덱스)}
  let best = null;
  for (let a = 0; a < idsOrCards.length; a++) for (let b = a + 1; b < idsOrCards.length; b++) {
    const h = evalHand(CARDS[idsOrCards[a]], CARDS[idsOrCards[b]]);
    if (!best || h.s > best.h.s) best = { h, pair: [a, b] };
  }
  return best;
}

/* ===================== 테이블 공통 ===================== 
*/
const blank = () => ({ cards: [], bet: 0, total: 0, folded: false, allIn: false, acted: false, label: '', lcls: '', res: '', winAmt: 0, reveal: false, note: '', openIdx: -1, fin: null, h: null, use: null, sc: 0, best: null });
const TABLES = new Map();

class Table {
  constructor(def) {
    Object.assign(this, def);
    this.seats = Array(MAXSEATS).fill(null);
    this.logs = []; this.msg = ''; this.big = false;
    this.pend = new Map(); this.running = false; this.wake = null;
    this.hand = 0; this.handActive = false; this.dealer = -1; this.showdown = 
false;
  }
  log(t) { this.logs.push(t); if (this.logs.length > 40) this.logs.shift(); }
  players() { return this.seats.filter(Boolean); }
  connected(s) { return !!(s.sess && s.sess.res); }
  poke() { if (this.wake) { const w = this.wake; this.wake = null; w(); } }

  sit(sess) {
    if (seated.has(sess.nick)) return { err: '이전 테이블 정산 중입니다. 잠시 후 다시 시도하세요.' };
    const idx = this.seats.findIndex(s => !s);
    if (idx < 0) return { err: '만석입니다 (최대 ' + MAXSEATS + '명)' };
    const rec = 
DB.players[sess.nick];
    const seat = Object.assign(blank(), { idx, nick: sess.nick, sess, chips: rec.chips, sitOut: rec.chips < this.minChips, inHand: false, leaving: false, timeouts: 0, discAt: 0 });
    this.seats[idx] = seat; sess.table = this; sess.seat = seat; seated.set(sess.nick, seat);
    this.log(`${sess.nick} 입장`);
    this.start(); this.poke(); this.broadcast(); pushLobby();
    return { ok: true };
  }
  leave(sess) {
    const seat = sess.seat; if (!seat || sess.table !== this) return;
    sess.table = null; sess.seat = null;
    seat.leaving = true; this.log(`${seat.nick} 
퇴장`);
    if (seat.inHand && this.handActive) {
      if (!seat.allIn && !seat.folded) { seat.folded = true; seat.label = '다이'; seat.lcls = 'fold'; }
      const pd = this.pend.get(seat.idx); if (pd) pd.finish({ leave: true });
    } else this.removeSeat(seat);
    this.broadcast(); pushLobby();
  }
  removeSeat(seat) {
    if (this.seats[seat.idx] === seat) this.seats[seat.idx] = null;
    const rec = DB.players[seat.nick]; if (rec) rec.chips = seat.chips;
    if (seated.get(seat.nick) === seat) seated.delete(seat.nick);
    
saveDB();
  }
  broadcast() {
    for (const s of this.players()) if (s.sess && s.sess.res && s.sess.seat === s) sseSend(s.sess, this.stateFor(s));
  }
  /* 입력 대기: 시간 초과/퇴장 시 {timeout|leave:true} 로 해제 */
  ask(seat, kind, payload, ms, validate) {
    return new Promise(res => {
      const conn = this.connected(seat), to = conn ? ms : 2500;
      let done = false, t;
      const pd = { seat: seat.idx, kind, payload, validate, deadline: Date.now() + to / SPEED };
      pd.finish = a => { if (done) return; done = true; clearTimeout(t); 
if (this.pend.get(seat.idx) === pd) this.pend.delete(seat.idx); res(a); };
      t = setTimeout(() => { if (conn) seat.timeouts++; pd.finish({ timeout: true }); }, to / SPEED);
      this.pend.set(seat.idx, pd);
      this.broadcast();
    });
  }
  onAct(seat, a) {
    const pd = this.pend.get(seat.idx);
    if (!pd) return { err: '지금은 선택할 차례가 아닙니다' };
    const v = pd.validate(a);
    if (!v) return { err: '올바르지 않은 선택입니다' };
    seat.timeouts = 0; pd.finish(v); return { ok: true 
};
  }
  cleanup() {
    const now = Date.now();
    for (const s of this.players()) {
      const rec = DB.players[s.nick]; if (rec) rec.chips = s.chips;
      if (s.inHand && s.timeouts >= 2) { s.sitOut = true; s.timeouts = 0; this.log(`${s.nick} 무응답 → 자리비움`); }
      if (s.chips < this.minChips && !s.sitOut) { s.sitOut = true; this.log(`${s.nick} 칩 부족 → 자리비움 (충전 가능)`); }
      s.inHand = false;
      if (s.leaving) this.removeSeat(s);
      else if (!this.connected(s) && s.discAt && now - s.discAt > 45000 / SPEED) 
{
        this.log(`${s.nick} 연결 끊김 → 퇴장`);
        if (s.sess && s.sess.seat === s) { s.sess.table = null; s.sess.seat = null; }
        this.removeSeat(s);
      }
    }
    saveDB();
  }
  readyList() { return this.seats.filter(s => s && !s.sitOut && !s.leaving && s.chips >= this.minChips && this.connected(s)); }
  start() { if (this.running) return; this.running = true; this.loop(); }
  async loop() {
    while (true) 
{
      try {
        const ok = await this.playHand();
        if (!ok) {
          this.handActive = false;
          this.msg = this.players().length > 1 ? '게임을 시작할 인원을 기다리는 중…' : '다른 플레이어를 기다리는 중…';
          this.broadcast();
          await Promise.race([new Promise(r => { this.wake = r; }), sleep(5000)]);
          this.wake = null; await sleep(800);
        }
      } catch (e) {
        console.error('[table ' + this.id + '] 오류:', 
e);
        this.pend.forEach(p => p.finish({ leave: true })); this.pend.clear();
        this.handActive = false; this.players().forEach(s => { s.inHand = false; });
        this.msg = '오류가 발생해 잠시 후 다시 시작합니다'; this.broadcast();
        await sleep(2500);
      }
    }
  }
  /* 베팅 입력 검증 (공통) */
  betValidator(canCheck, opts) {
    return a => 
{
      if (!a) return null;
      if (a.type === 'fold') return { type: 'fold' };
      if (a.type === 'check' && canCheck) return { type: 'check' };
      if (a.type === 'call' && !canCheck) return { type: 'call' };
      if (a.type === 'raise') { const o = opts.find(x => x.label === a.label); if (o) return { type: 'raise', to: o.to, label: o.label }; }
      return null;
    };
  }
  commit(p, amt) { amt = Math.max(0, Math.min(amt, p.chips)); p.chips -= amt; p.bet += amt; p.total += amt; if (p.chips === 0) p.allIn = true; p.acted = true; return amt; }
  turnView(pd) { return Object.assign({ kind: pd.kind, ms: 
Math.max(0, pd.deadline - Date.now()) }, pd.payload); }
  commonState(v) {
    const pd = this.pend.get(v.idx);
    const pot = this.players().reduce((a, s) => a + s.total - s.bet, 0);
    return {
      t: 'table', game: this.game, mode: this.mode || 0, room: { id: this.id, name: this.name, desc: this.desc },
      you: v.idx, hand: this.hand, msg: this.msg, big: this.big, pot, showdown: this.showdown,
      seats: this.seats.map(s => s ? this.seatView(s, v) : null),
      turn: pd ? this.turnView(pd) : null, logs: this.logs.slice(-9), minChips: this.minChips,
      me: { nick: v.nick, chips: v.chips, sitOut: v.sitOut, canRefill: v.chips < REFILL_BELOW && !(v.inHand && this.handActive && 
!v.folded) && refillWait(v.nick, v.chips) === 0, refillWait: (v.chips < REFILL_BELOW && !(v.inHand && this.handActive && !v.folded)) ? Math.ceil(refillWait(v.nick, v.chips) / 1000) : 0 }
    };
  }
  baseSeat(s) {
    return { idx: s.idx, nick: s.nick, chips: s.chips, bet: s.bet, folded: s.folded, allIn: s.allIn, sitOut: s.sitOut, off: !this.connected(s), wait: !s.inHand && this.handActive, label: s.label, lcls: s.lcls, res: s.res, win: s.winAmt, turn: this.pend.has(s.idx), leaving: s.leaving };
  }
  async finishHand(hp, win) {   // 전적 갱신 + 칩 저장
    for (const p of hp) {
      const rec = DB.players[p.nick]; if (!rec) 
continue;
      rec.hands = (rec.hands || 0) + 1; rec.chips = p.chips; rec.last = Date.now();
      const w = win.get(p) || 0;
      if (w > 0) { rec.wins = (rec.wins || 0) + 1; const net = w - p.total; if (net > (rec.best || 0)) rec.best = net; }
    }
    saveDB();
  }
}

/* ===================== 텍사스 홀덤 ===================== */
class HoldemTable extends Table {
  constructor(def) { super(Object.assign({ game: 'holdem', 
minChips: BB }, def)); this.board = []; this.cur = 0; this.minRaise = BB; this.hl = null; }
  raiseOpts(p) {
    const cur = this.cur, call = Math.min(cur - p.bet, p.chips), cap = p.bet + p.chips, pot = this.potAll();
    const minTo = cur === 0 ? BB : cur + this.minRaise, o = [], used = new Set();
    const rnd = v => Math.round(v / 1000) * 1000;
    const mk = (label, to) => { to = Math.max(rnd(to), minTo); if (to < cap && !used.has(to)) { o.push({ label, to }); used.add(to); } };
    if (cur === 0) mk('삥', BB); else mk('따당', 2 * cur);
    const pac = pot + call;
    mk('쿼터', cur + pac * .25); mk('하프', cur + pac * .5); mk('풀', cur + 
pac);
    if (p.chips > call) o.push({ label: '올인', to: cap });
    return o;
  }
  potAll() { return this.players().reduce((a, s) => a + s.total, 0); }
  apply(p, a) {
    let txt = '';
    if (a.type === 'fold') { p.folded = true; p.acted = true; p.label = '다이'; p.lcls = 'fold'; txt = '다이'; }
    else if (a.type === 'check') { p.acted = true; p.label = '체크'; p.lcls = 'check'; txt = '체크'; }
    else if (a.type === 'call') { const amt = this.commit(p, Math.min(this.cur - p.bet, p.chips)); p.label = p.allIn ? '올인' : '콜'; p.lcls = p.allIn ? 'allin' : 'call'; txt = `${p.label} 
${amt.toLocaleString('ko-KR')}`; }
    else {
      const to = Math.min(a.to, p.bet + p.chips); this.commit(p, to - p.bet);
      if (to > this.cur) { if (to - this.cur >= this.minRaise) this.minRaise = to - this.cur; this.cur = to; }
      p.label = p.allIn ? '올인' : a.label; p.lcls = p.allIn ? 'allin' : 'raise'; txt = `${p.label} (총 ${to.toLocaleString('ko-KR')})`;
    }
    this.log(`${p.nick}: ${txt}`);
  }
  async getBet(p) {
    const cur = this.cur, call = Math.min(cur - p.bet, p.chips), canCheck = cur === p.bet, opts = 
this.raiseOpts(p);
    const a = await this.ask(p, 'bet', { call, canCheck, opts }, 25000, this.betValidator(canCheck, opts));
    if (!a || a.timeout || a.leave) return canCheck ? { type: 'check' } : { type: 'fold' };
    return a;
  }
  async betting(hp, pos) {
    const n = hp.length; let i = pos, guard = 0;
    const alive = () => hp.filter(p => !p.folded);
    const actors = () => hp.filter(p => !p.folded && !p.allIn).length;
    const needs = p => !p.folded && !p.allIn && (p.bet < this.cur || (!p.acted && actors() > 1));
    while (guard++ < 600) 
{
      if (alive().length <= 1) return;
      if (!hp.some(needs)) return;
      const p = hp[i];
      if (needs(p)) {
        const a = await this.getBet(p);
        this.apply(p, a); this.broadcast(); await sleep(a.type === 'fold' ? 350 : 450);
      }
      i = (i + 1) % n;
    }
  }
  async playHand() {
    const hp = 
this.readyList();
    if (hp.length < 2) return false;
    this.hand++; this.handActive = true; this.showdown = false; this.big = false; this.msg = ''; this.hl = null;
    this.seats.forEach(s => { if (s) { Object.assign(s, blank()); s.inHand = false; } });
    hp.forEach(p => p.inHand = true);
    const n = hp.length;
    let di = hp.findIndex(p => p.idx > this.dealer); if (di < 0) di = 0; this.dealer = hp[di].idx;
    const sbP = n === 2 ? hp[di] : hp[(di + 1) % n], bbPos = n === 2 ? (di + 1) % 2 : (di + 2) % n, bbP = hp[bbPos];
    const deck = shuffle(FULL.slice());
    this.board = []; this.cur = 0; this.minRaise = 
BB;
    this.log(`── ${this.hand}번째 판 ──`); this.broadcast(); await sleep(450);
    for (let r = 0; r < 2; r++) for (let k = 1; k <= n; k++) hp[(di + k) % n].cards.push(deck.pop());
    this.commit(sbP, SB); this.commit(bbP, BB); sbP.acted = false; bbP.acted = false;
    sbP.label = 'SB'; sbP.lcls = 'blind'; bbP.label = 'BB'; bbP.lcls = 'blind';
    this.cur = BB;
    this.broadcast(); await sleep(700);
    const names = ['프리플랍', '플랍', '턴', '리버'];
    let revealed = false;
    for (let st = 0; st < 4; st++) {
      if (st > 0) 
{
        hp.forEach(p => { p.bet = 0; p.acted = false; if (!p.folded) { p.label = ''; p.lcls = ''; } });
        this.cur = 0; this.minRaise = BB;
        const k = st === 1 ? 3 : 1; for (let i = 0; i < k; i++) this.board.push(deck.pop());
        this.msg = names[st]; this.log(`[${names[st]}] ` + this.board.map(c => '♠♥♦♣'[c.s] + ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[c.r] || c.r)).join(' '));
        this.broadcast(); await sleep(st === 1 ? 900 : 700); this.msg = '';
      }
      if (hp.filter(p => !p.folded).length > 1) await this.betting(hp, st === 0 ? (bbPos + 1) % n : (di + 1) % n);
      if (hp.filter(p => !p.folded).length <= 1) 
break;
      const able = hp.filter(p => !p.folded && !p.allIn);
      if (able.length <= 1 && hp.some(p => p.allIn && !p.folded) && !revealed) {
        revealed = true; hp.filter(p => !p.folded).forEach(p => p.reveal = true);
        this.msg = '올인! 패를 공개합니다'; this.broadcast(); await sleep(1600);
      }
    }
    this.showdown = false;
    await this.settle(hp);
    this.handActive = false;
    this.cleanup(); this.broadcast(); 
pushLobby();
    return true;
  }
  async settle(hp) {
    const al = hp.filter(p => !p.folded);
    const win = new Map(hp.map(p => [p, 0]));
    hp.forEach(p => { p.label = ''; p.lcls = ''; p.bet = 0; });
    const potAll = hp.reduce((a, p) => a + p.total, 0);
    let mainW = null;
    if (al.length === 1) { win.set(al[0], potAll); mainW = [al[0]]; this.msg = `${al[0].nick} 승리 (모두 다이)`; }
    else {
      this.showdown = true;
      al.forEach(p => { p.reveal = true; const b = 
best7(p.cards.concat(this.board)); p.sc = b.score; p.best = b.cards; p.res = handName(b.score); });
      const levels = [...new Set(hp.filter(p => p.total > 0).map(p => p.total))].sort((a, b) => a - b);
      let prev = 0, carry = 0;
      for (const lv of levels) {
        let amt = carry; hp.forEach(p => { amt += Math.max(0, Math.min(p.total, lv) - prev); }); prev = lv;
        const el = al.filter(p => p.total >= lv);
        if (!el.length) { carry = amt; continue; } carry = 0;
        const top = Math.max(...el.map(p => p.sc)), w = el.filter(p => p.sc === top);
        const share = Math.floor(amt / w.length / 1000) * 1000;
        w.forEach(p => win.set(p, win.get(p) + 
share));
        win.set(w[0], win.get(w[0]) + amt - share * w.length);
        if (!mainW) mainW = w;
      }
      if (carry > 0 && mainW) win.set(mainW[0], win.get(mainW[0]) + carry);
      this.hl = mainW[0].best.map(c => c.id);
      this.msg = mainW.map(p => p.nick).join(', ') + ' 승리 - ' + handName(mainW[0].sc);
    }
    hp.forEach(p => {
      const w = win.get(p); p.chips += w;
      if (w > 0) { p.winAmt = w; p.res = (p.res ? p.res + '  ' : '') + '+' + w.toLocaleString('ko-KR'); this.log(`${p.nick} 
+${w.toLocaleString('ko-KR')}${al.length > 1 ? ' (' + handName(p.sc) + ')' : ''}`); }
    });
    await this.finishHand(hp, win);
    hp.forEach(p => { p.total = 0; p.bet = 0; });
    this.broadcast();
    await sleep(al.length === 1 ? 2600 : 5200);
  }
  seatView(s, v) {
    const me = s === v, show = me || s.reveal;
    const o = this.baseSeat(s);
    o.cards = s.cards.map(c => show ? c.id : -1);
    o.reveal = !!s.reveal;
    o.note = 
'';
    if (me && s.inHand && !s.folded && s.cards.length === 2 && this.board.length >= 3 && !this.showdown) o.note = '내 패: ' + handName(bestScore(s.cards.concat(this.board)));
    return o;
  }
  stateFor(v) {
    const st = this.commonState(v);
    st.board = this.board.map(c => c.id); st.hl = this.hl; st.dealer = this.handActive ? this.dealer : -1;
    return st;
  }
}

/* ===================== 섯다 ===================== */
class SeotdaTable extends Table {
  constructor(def) { super(Object.assign({ game: 'seotda', minChips: ANTE }, def)); this.sun = -1; this.cur = 0; this.minRaise = ANTE; this.raiseCount = 0; this.round = 1; this.rematch = 0; } 
   potAll() { return this.players().reduce((a, s) => a + s.total, 0); }
  raiseOpts(p) {
    if (this.raiseCount >= RAISE_CAP) return [];
    const cur = this.cur, call = Math.min(cur - p.bet, p.chips), cap = p.bet + p.chips, pot = this.potAll();
    const minTo = cur === 0 ? ANTE : cur + this.minRaise, o = [], used = new Set();
    const rnd = v => Math.round(v / 1000) * 1000;
    const mk = (label, to) => { to = Math.max(rnd(to), minTo); if (to < cap && !used.has(to)) { o.push({ label, to }); used.add(to); } };
    if (cur === 0) mk('삥', ANTE); else mk('따당', 2 * cur);
    const pac = pot + call;
    mk('쿼터', cur + pac * .25); mk('하프', cur + pac * .5); mk('풀', cur + 
pac);
    if (p.chips > call) o.push({ label: '올인', to: cap });
    return o;
  }
  apply(p, a) {
    let txt = '';
    if (a.type === 'fold') { p.folded = true; p.acted = true; p.label = '다이'; p.lcls = 'fold'; txt = '다이'; }
    else if (a.type === 'check') { p.acted = true; p.label = '체크'; p.lcls = 'check'; txt = '체크'; }
    else if (a.type === 'call') { const amt = this.commit(p, Math.min(this.cur - p.bet, p.chips)); p.label = p.allIn ? '올인' : '콜'; p.lcls = p.allIn ? 'allin' : 'call'; txt = `${p.label} ${amt.toLocaleString('ko-KR')}`; 
}
    else {
      const to = Math.min(a.to, p.bet + p.chips); this.commit(p, to - p.bet);
      if (to > this.cur) { if (to - this.cur >= this.minRaise) this.minRaise = to - this.cur; this.cur = to; this.raiseCount++; }
      p.label = p.allIn ? '올인' : a.label; p.lcls = p.allIn ? 'allin' : 'raise'; txt = `${p.label} (총 ${to.toLocaleString('ko-KR')})`;
    }
    this.log(`${p.nick}: ${txt}`);
  }
  async getBet(p) {
    const cur = this.cur, call = Math.min(cur - p.bet, p.chips), canCheck = cur === p.bet, opts = 
this.raiseOpts(p);
    const a = await this.ask(p, 'bet', { call, canCheck, opts }, 25000, this.betValidator(canCheck, opts));
    if (!a || a.timeout || a.leave) return canCheck ? { type: 'check' } : { type: 'fold' };
    return a;
  }
  startRound(hp, r) {
    this.round = r; this.cur = 0; this.minRaise = ANTE; this.raiseCount = 0;
    hp.forEach(p => { p.bet = 0; p.acted = false; if (!p.folded) { p.label = ''; p.lcls = ''; } });
  }
  async betting(hp) 
{
    const n = hp.length;
    let i = hp.findIndex(p => p.idx >= this.sun); if (i < 0) i = 0;
    const alive = () => hp.filter(p => !p.folded);
    const actors = () => hp.filter(p => !p.folded && !p.allIn).length;
    const needs = p => !p.folded && !p.allIn && (p.bet < this.cur || (!p.acted && actors() > 1));
    let guard = 0;
    while (guard++ < 600) {
      if (alive().length <= 1) return;
      if (!hp.some(needs)) return;
      const p = hp[i];
      if (needs(p)) {
        const a = await 
this.getBet(p);
        this.apply(p, a); this.broadcast(); await sleep(a.type === 'fold' ? 350 : 450);
      }
      i = (i + 1) % n;
    }
  }
  orderFrom(hp, idx) { return hp.filter(p => p.idx > idx).concat(hp.filter(p => p.idx <= idx)); }
  async playDeal(hp) {
    const deck = shuffle([...Array(20).keys()]);
    hp.forEach(p => { p.cards = []; p.openIdx = -1; p.fin = null; p.h = null; p.reveal = false; p.res = ''; p.note = ''; p.bet = 0; p.acted = false; p.label = ''; p.lcls = ''; p.winAmt = 0; p.use = null; 
});
    this.showdown = false; this.msg = ''; this.big = false; this.round = 1;
    const order = this.orderFrom(hp, this.sun).filter(p => !p.folded);
    this.broadcast(); await sleep(250);
    if (this.mode === 2) {
      for (const p of order) p.cards.push(deck.pop());
      this.msg = '첫 번째 패'; this.broadcast(); await sleep(1000); this.msg = '';
    } else {
      for (let r = 0; r < 2; r++) for (const p of order) p.cards.push(deck.pop());
      this.broadcast(); await sleep(700);
      const alive = hp.filter(p => 
!p.folded);
      this.msg = '공개할 카드를 고르세요'; this.broadcast();
      await Promise.all(alive.map(async p => {
        const a = await this.ask(p, 'open', { cards: p.cards.map(c => c) }, 15000, a => (a && Number.isInteger(a.k) && a.k >= 0 && a.k < p.cards.length) ? { k: a.k } : null);
        p.openIdx = (a && Number.isInteger(a.k)) ? a.k : Math.floor(Math.random() * 2);
        this.log(`${p.nick}: ${CARDS[p.cards[p.openIdx]].m}월 ${typ(CARDS[p.cards[p.openIdx]])} 공개`);
      }));
      this.msg = '1차 베팅'; this.broadcast(); await sleep(600); this.msg = '';
    
}
    this.startRound(hp, 1);
    await this.betting(hp);
    if (hp.filter(p => !p.folded).length <= 1) return;
    // 두 번째(2장섯다) / 세 번째(3장섯다) 패
    for (const p of order) if (!p.folded) p.cards.push(deck.pop());
    this.msg = this.mode === 2 ? '두 번째 패' : '세 번째 패'; this.broadcast(); await sleep(900); this.msg = '';
    this.startRound(hp, 2); this.broadcast();
    await this.betting(hp);
    if (hp.filter(p => !p.folded).length <= 1) return;
    const alive = hp.filter(p => !p.folded);
    if (this.mode === 3) {
      this.msg = '최종 승부할 2장을 고르세요'; 
this.broadcast();
      await Promise.all(alive.map(async p => {
        const bp = bestPair(p.cards);
        const pairs = [[0, 1], [0, 2], [1, 2]].map(pr => ({ pr, name: evalHand(CARDS[p.cards[pr[0]]], CARDS[p.cards[pr[1]]]).name }));
        const best = pairs.findIndex(x => x.pr[0] === bp.pair[0] && x.pr[1] === bp.pair[1]);
        const a = await this.ask(p, 'final', { cards: p.cards.slice(), pairs, best }, 20000, a => {
          if (!a || !Array.isArray(a.pr) || a.pr.length !== 2) return null;
          const [x, y] = a.pr.map(Number).sort();
          return (x !== y && x >= 0 && y <= 2 && Number.isInteger(x) && Number.isInteger(y)) ? { pr: [x, y] } : null;
        
});
        p.fin = (a && a.pr) ? a.pr : bp.pair;
      }));
      this.msg = '';
    } else alive.forEach(p => p.fin = [0, 1]);
  }
  async showdownStep(hp) {
    const al = hp.filter(p => !p.folded);
    al.forEach(p => { p.reveal = true; p.use = p.fin.slice(); p.h = evalHand(CARDS[p.cards[p.fin[0]]], CARDS[p.cards[p.fin[1]]]); p.res = p.h.name; p.note = ''; p.label = ''; p.lcls = ''; });
    this.showdown = true; hp.forEach(p => p.bet = 0);
    this.msg = '패 공개!'; this.big = false; this.broadcast(); await 
sleep(1800);
    return resolve(al.map(p => ({ i: p.idx, h: p.h })));
  }
  async playHand() {
    const hp = this.readyList();
    if (hp.length < 2) return false;
    this.hand++; this.handActive = true; this.rematch = 0; this.showdown = false; this.big = false; this.msg = '';
    this.seats.forEach(s => { if (s) { Object.assign(s, blank()); s.inHand = false; } });
    hp.forEach(p => { p.inHand = true; const a = Math.min(ANTE, p.chips); p.chips -= a; p.total = a; if (p.chips === 0) p.allIn = true; });
    if (!hp.some(p => p.idx === this.sun)) this.sun = hp[0].idx;
    this.log(`── ${this.hand}번째 판 (${this.mode}장) ──`); 
this.broadcast(); await sleep(600);
    let r = null;
    while (true) {
      await this.playDeal(hp);
      if (hp.filter(p => !p.folded).length <= 1) break;
      r = await this.showdownStep(hp);
      if (r.type === 're' && this.rematch < 6) {
        this.rematch++;
        const alive = hp.filter(p => !p.folded);
        const keep = r.who || alive.map(p => p.idx);
        hp.forEach(p => { if (!keep.includes(p.idx) && !p.folded) p.folded = true; });
        this.msg = r.why === '무승부' ? `무승부! ${keep.map(i => this.seats[i].nick).join(', ')} 재경기` : `${r.why} 발동! 
재경기`;
        this.big = true; this.log(this.msg); this.broadcast(); await sleep(2800);
        continue;
      }
      break;
    }
    await this.settle(hp);
    this.handActive = false;
    this.cleanup(); this.broadcast(); pushLobby();
    return true;
  }
  async settle(hp) {
    const al = hp.filter(p => 
!p.folded);
    const win = new Map(hp.map(p => [p, 0]));
    hp.forEach(p => { p.label = ''; p.lcls = ''; p.bet = 0; });
    const potAll = hp.reduce((a, p) => a + p.total, 0);
    let mainW = null;
    if (al.length === 1) { win.set(al[0], potAll); mainW = [al[0]]; this.msg = `${al[0].nick} 승리 (모두 다이)`; this.big = false; al[0].res = ''; }
    else {
      const levels = [...new Set(hp.filter(p => p.total > 0).map(p => p.total))].sort((a, b) => a - b);
      let prev = 0, carry = 0;
      for (const lv of levels) {
        let amt = carry; hp.forEach(p => { amt += Math.max(0, 
Math.min(p.total, lv) - prev); }); prev = lv;
        const el = al.filter(p => p.total >= lv);
        if (!el.length) { carry = amt; continue; } carry = 0;
        let w;
        if (el.length === 1) w = [el[0]];
        else { const rr = resolve(el.map(p => ({ i: p.idx, h: p.h }))); w = rr.type === 'win' ? rr.w.map(i => this.seats[i]) : (rr.who ? rr.who.map(i => this.seats[i]) : el); }
        const share = Math.floor(amt / w.length / 1000) * 1000;
        w.forEach(p => win.set(p, win.get(p) + share));
        win.set(w[0], win.get(w[0]) + amt - share * w.length);
        if (!mainW) mainW = w;
      }
      if (carry > 0 && mainW) win.set(mainW[0], win.get(mainW[0]) 
+ carry);
      const hn = mainW[0].h.name;
      this.msg = mainW.map(p => p.nick).join(', ') + ' 승리 - ' + hn;
      this.big = /광땡|장땡|땡잡이|암행어사/.test(hn);
    }
    hp.forEach(p => {
      const w = win.get(p); p.chips += w;
      if (w > 0) { p.winAmt = w; p.res = (p.res ? p.res + '  ' : '') + '+' + w.toLocaleString('ko-KR'); this.log(`${p.nick} +${w.toLocaleString('ko-KR')}${p.h && al.length > 1 ? ' (' + p.h.name + ')' : ''}`); }
    });
    if (mainW) this.sun = mainW[0].idx;
    await this.finishHand(hp, 
win);
    hp.forEach(p => { p.total = 0; p.bet = 0; });
    this.broadcast();
    await sleep(al.length === 1 ? 2600 : 5200);
  }
  seatView(s, v) {
    const me = s === v, o = this.baseSeat(s);
    o.cards = s.cards.map((c, k) => (me || s.reveal || k === s.openIdx) ? c : -1);
    o.open = s.openIdx; o.use = s.reveal ? s.use : null; o.reveal = !!s.reveal; o.note = '';
    if (me && s.inHand && !s.folded && !this.showdown && s.cards.length >= 1) {
      if (s.cards.length === 1) { const c = CARDS[s.cards[0]]; o.note = 
`첫 패: ${c.m}월 ${typ(c)}`; }
      else o.note = '내 패: ' + bestPair(s.cards).h.name;
    }
    return o;
  }
  stateFor(v) {
    const st = this.commonState(v);
    st.dealer = this.handActive ? this.sun : -1; st.rematch = this.rematch; st.round = this.round;
    return st;
  }
}

/* ===================== 방 목록 ===================== 
*/
[
  new HoldemTable({ id: 'h1', name: '텍사스 홀덤 1', desc: '블라인드 5,000 / 10,000' }),
  new HoldemTable({ id: 'h2', name: '텍사스 홀덤 2', desc: '블라인드 5,000 / 10,000' }),
  new SeotdaTable({ id: 's2', mode: 2, name: '섯다 · 2장', desc: '판돈 10,000 · 한 장씩 받고 베팅 2번' }),
  new SeotdaTable({ id: 's3', mode: 3, name: '섯다 · 3장', desc: '판돈 10,000 · 1장 공개 → 베팅 → 3번째 패 → 베팅' }),
].forEach(t => TABLES.set(t.id, t));

/* ===================== 충전 대기 ===================== */
function refillWait(nick, chips) 
{
  const rec = DB.players[nick]; if (!rec) return 0;
  if (chips >= REFILL_BELOW) { if (rec.brokeAt) { rec.brokeAt = 0; saveDB(); } return 0; }
  if (!rec.brokeAt) {
    rec.brokeAt = Date.now(); saveDB();
    setTimeout(() => { pushLobby(); for (const t of TABLES.values()) { try { t.broadcast(); } catch (e) { } } }, REFILL_WAIT + 800);
  }
  return Math.max(0, rec.brokeAt + REFILL_WAIT - Date.now());
}
/* ===================== 로비 ===================== */
function lobbyFor(sess) {
  const rec = DB.players[sess.nick] || 
{};
  const rooms = [...TABLES.values()].map(t => ({ id: t.id, game: t.game, name: t.name, desc: t.desc, count: t.players().length, max: MAXSEATS, players: t.players().map(s => ({ nick: s.nick, chips: s.chips })) }));
  const rank = Object.values(DB.players).map(r => ({ nick: r.nick, chips: chipsOf(r.nick), wins: r.wins || 0, hands: r.hands || 0, online: !!(byNick.get(r.nick) && byNick.get(r.nick).res) }))
    .sort((a, b) => b.chips - a.chips).slice(0, 10);
  const chips = chipsOf(sess.nick);
  return {
    t: 'lobby', me: { nick: sess.nick, chips, hands: rec.hands || 0, wins: rec.wins || 0, best: rec.best || 0, canRefill: chips < REFILL_BELOW && refillWait(sess.nick, chips) === 0, refillWait: chips < 
REFILL_BELOW ? Math.ceil(refillWait(sess.nick, chips) / 1000) : 0 },
    rooms, rank, online: [...sessions.values()].filter(s => s.res).length
  };
}
let lobbyTimer = null;
function pushLobby() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => { lobbyTimer = null; for (const s of sessions.values()) if (s.res && !s.table) sseSend(s, lobbyFor(s)); }, 250 / Math.min(SPEED, 5));
}
function sendView(sess) {
  if (sess.table && sess.seat) sseSend(sess, sess.table.stateFor(sess.seat)); else sseSend(sess, 
lobbyFor(sess));
}

/* ===================== API ===================== */
function doLogin(b, ip) {
  const nick = String(b.nick || '').trim().replace(/\s+/g, ' ');
  if (!/^[\p{L}\p{N}_\-. ]{1,10}$/u.test(nick)) return { status: 400, obj: { err: '닉네임은 1~10자(한글/영문/숫자)로 입력하세요' } };
  const pinH = b.pin ? hash(String(b.pin).slice(0, 20)) : '';
  let rec = DB.players[nick];
  if (!rec) {
    if (!ip) return { status: 400, obj: { err: '기기 정보를 확인할 수 없습니다. 새로고침 후 다시 시도하세요' } };
    const dup = Object.values(DB.players).find(r => r.ip && r.ip === 
ip);
    if (dup) return { status: 403, obj: { err: '이 기기에서는 이미 계정이 있습니다. 기존 닉네임 "' + dup.nick.slice(0, 1) + '***"으로 로그인하세요 (계정은 기기당 1개)' } };
  }
  if (!rec) rec = DB.players[nick] = { ip, nick, pin: pinH, chips: START_CHIPS, hands: 0, wins: 0, best: 0, refills: 0, created: Date.now(), last: Date.now() };
  else if (rec.pin && rec.pin !== pinH) return { status: 403, obj: { err: 'PIN이 틀렸습니다' } };
  else if (!rec.pin && pinH) rec.pin = pinH;
  const token = crypto.randomBytes(12).toString('hex');
  const sess = { token, nick, res: null, table: null, seat: null, born: Date.now(), lastChat: 0 
};
  const old = byNick.get(nick);
  if (old) {
    sess.table = old.table; sess.seat = old.seat; if (sess.seat) { sess.seat.sess = sess; sess.seat.discAt = 0; }
    if (old.res) { sseSend(old, { t: 'kicked', msg: '다른 곳에서 같은 닉네임으로 접속해 이 화면은 종료됩니다' }); try { old.res.end(); } catch (e) { } old.res = null; }
    sessions.delete(old.token);
  }
  sessions.set(token, sess); byNick.set(nick, sess);
  if (ip && (!rec.ip || /[.:]/.test(rec.ip))) rec.ip = ip;
  rec.last = Date.now(); saveDB();
  return { status: 200, obj: { ok: true, token, nick, newbie: 
rec.hands === 0 && rec.chips === START_CHIPS } };
}
const ADMIN_PW = process.env.ADMIN_PASSWORD || '';
let adminFails = 0, adminLockUntil = 0;
function adminOk(pw) {
  if (!ADMIN_PW) return false;
  const a = crypto.createHash('sha256').update(String(pw || '')).digest(), c = crypto.createHash('sha256').update(ADMIN_PW).digest();
  return crypto.timingSafeEqual(a, c);
}
function doAdmin(b) {
  if (!ADMIN_PW) return { status: 403, obj: { err: '서버에 ADMIN_PASSWORD가 설정되지 않았습니다' } 
};
  if (Date.now() < adminLockUntil) return { status: 429, obj: { err: '시도가 너무 많습니다. 잠시 후 다시 시도하세요' } };
  if (!adminOk(b.pw)) { if (++adminFails >= 5) { adminFails = 0; adminLockUntil = Date.now() + 5 * 60 * 1000; } return { status: 403, obj: { err: '관리자 암호가 틀렸습니다' } }; }
  adminFails = 0;
  const nick = String(b.nick || '');
  const rec = DB.players[nick];
  if (b.action === 'list') {
    return { status: 200, obj: { ok: true, players: Object.values(DB.players).map(r => ({ nick: r.nick, chips: chipsOf(r.nick), hasPin: !!r.pin, hands: r.hands || 0, last: r.last || 0, device: r.ip ? 'O' : 'X' })).sort((x, y) => y.last - x.last) } 
};
  }
  if (!rec) return { status: 404, obj: { err: '그런 닉네임이 없습니다' } };
  if (b.action === 'resetpin') { rec.pin = ''; saveDB(); return { status: 200, obj: { ok: true, msg: nick + ' PIN 초기화됨 - 새 PIN으로 로그인하면 설정됩니다' } }; }
  if (b.action === 'unlockdev') { rec.ip = ''; saveDB(); return { status: 200, obj: { ok: true, msg: nick + ' 기기 연결 해제됨' } }; }
  if (b.action === 'delete') {
    if (seated.get(nick)) return { status: 400, obj: { err: '게임 중인 계정은 삭제할 수 없습니다' } };
    delete DB.players[nick]; saveDB(); return { status: 200, obj: { ok: true, msg: nick + ' 삭제됨 (같은 기기에서 새 계정을 만들 수 있습니다)' } 
};
  }
  return { status: 400, obj: { err: '알 수 없는 동작' } };
}
const ADMIN_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>관리자</title>
<style>body{font:15px sans-serif;background:#111;color:#eee;max-width:560px;margin:20px auto;padding:0 12px}input,button{font:inherit;padding:8px;margin:3px 0;border-radius:6px;border:1px solid #555;background:#222;color:#eee}button{cursor:pointer;background:#2a6}table{width:100%;border-collapse:collapse;margin-top:10px}td,th{border-bottom:1px solid #333;padding:6px 
4px;text-align:left}.b{background:#a33;margin-left:4px}.o{background:#36a;margin-left:4px}#m{color:#fc6;min-height:1.4em}</style>
<h2>🔧 포커 관리자</h2><input id="pw" type="password" placeholder="관리자 암호"> <button onclick="load()">목록 불러오기</button><div id="m"></div><table id="t"></table>
<script>
const $=id=>document.getElementById(id);
async function call(action,nick){const r=await fetch('/api/admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pw:$('pw').value,action,nick})});return r.json()}
async function load(){const j=await call('list');if(j.err){$('m').textContent=j.err;return}$('m').textContent='계정 
'+j.players.length+'개';
$('t').innerHTML='<tr><th>닉네임</th><th>칩</th><th>관리</th></tr>';
j.players.forEach(p=>{const tr=document.createElement('tr');const n=document.createElement('td');n.textContent=p.nick+(p.hasPin?'':' (PIN없음)');const c=document.createElement('td');c.textContent=p.chips.toLocaleString();const a=document.createElement('td');
[['PIN초기화','resetpin','o'],['기기해제','unlockdev','o'],['삭제','delete','b']].forEach(([l,act,cl])=>{const b=document.createElement('button');b.textContent=l;b.className=cl;b.onclick=async()=>{if(act==='delete'&&!confirm(p.nick+' 삭제할까요?'))return;const r=await 
call(act,p.nick);$('m').textContent=r.err||r.msg;load()};a.appendChild(b)});
tr.append(n,c,a);$('t').appendChild(tr)})}
</script>`;
function route(p, b, ip) {
  if (p === '/api/admin') return doAdmin(b);
  if (p === '/api/login') return doLogin(b, ip);
  const sess = sessions.get(b.token);
  if (!sess) return { status: 401, obj: { err: '로그인이 필요합니다', relogin: true } };
  const err = m => ({ status: 200, obj: { err: m } }), ok = () => ({ status: 200, obj: { ok: true } });
  switch (p) {
    case '/api/join': 
{
      const t = TABLES.get(b.room); if (!t) return err('없는 방입니다');
      if (sess.table) return err('이미 테이블에 앉아 있습니다');
      const r = t.sit(sess); if (r.err) return err(r.err);
      return ok();
    }
    case '/api/leave': {
      if (sess.table) sess.table.leave(sess);
      sendView(sess); return ok();
    }
    case '/api/act': {
      if (!sess.table || !sess.seat) return err('테이블에 앉아 있지 않습니다');
      const r = sess.table.onAct(sess.seat, b.action); return r.err ? 
err(r.err) : ok();
    }
    case '/api/chat': {
      if (!sess.table) return err('테이블에 앉아 있지 않습니다');
      const now = Date.now(); if (now - sess.lastChat < 700) return err('너무 빠릅니다');
      sess.lastChat = now;
      const text = String(b.text || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60); if (!text) return ok();
      sess.table.log(`💬 ${sess.nick}: ${text}`); sess.table.broadcast(); return ok();
    }
    case '/api/sitin': {
      const s = sess.seat; if (!s) return err('테이블에 앉아 있지 
않습니다');
      if (s.chips < sess.table.minChips) return err('칩이 부족합니다. 충전 버튼을 눌러주세요');
      s.sitOut = false; s.timeouts = 0; sess.table.poke(); sess.table.broadcast(); return ok();
    }
    case '/api/refill': {
      const rec = DB.players[sess.nick], s = sess.seat;
      const cur = s ? s.chips : rec.chips;
      const w = refillWait(sess.nick, cur);
      if (cur < REFILL_BELOW && w > 0) return err('충전까지 ' + Math.floor(Math.ceil(w / 1000) / 60) + '분 ' + (Math.ceil(w / 1000) % 60) + '초 남았습니다');
      if (cur >= REFILL_BELOW) return err('칩이 ' + 
REFILL_BELOW.toLocaleString('ko-KR') + ' 미만일 때만 충전할 수 있습니다');
      if (s && s.inHand && sess.table.handActive && !s.folded) return err('판이 끝난 뒤 충전하세요');
      if (s) s.chips = REFILL_TO;
      rec.chips = REFILL_TO; rec.brokeAt = 0; rec.refills = (rec.refills || 0) + 1; saveDB();
      if (s) { sess.table.log(`${sess.nick} 칩 충전 (${REFILL_TO.toLocaleString('ko-KR')})`); sess.table.poke(); sess.table.broadcast(); } else pushLobby();
      sendView(sess); return ok();
    }
  }
  return { status: 404, obj: { err: 'unknown api' } 
};
}
function onDisc(sess) {
  if (sess.seat) { sess.seat.discAt = Date.now(); if (sess.table) sess.table.broadcast(); }
  pushLobby();
}
function json(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(s);
}
function sse(req, res, token) {
  const sess = 
sessions.get(token);
  if (!sess) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('login required'); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 1500\n\n');
  if (sess.res && sess.res !== res) { try { sess.res.end(); } catch (e) { } }
  sess.res = res;
  if (sess.seat) sess.seat.discAt = 0;
  req.on('close', () => { if (sess.res === res) { sess.res = null; onDisc(sess); } });
  sendView(sess);
  if (sess.table) { sess.table.poke(); sess.table.start(); 
sess.table.broadcast(); }
  pushLobby();
}
function handle(req, res) {
  let u; try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  const p = u.pathname;
  if (req.method === 'GET') {
    if (p === '/' || p === '/index.html') {
      try { const html = fs.readFileSync(path.join(PUB, 'index.html')); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(html); }
      catch (e) { res.writeHead(500); return res.end('index.html not found'); 
}
    }
    if (p === '/admin') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); return res.end(ADMIN_HTML); }
    if (p === '/version') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('v4 admin+device-limit+refill-wait / accounts=' + Object.keys(DB.players).length); }
    if (p === '/api/events') return sse(req, res, u.searchParams.get('token'));
    if (p === '/api/ping') return json(res, 200, { ok: true, t: Date.now() });
    res.writeHead(404); return res.end('not found');
  
}
  if (req.method === 'POST' && p.startsWith('/api/')) {
    let body = '', big = false;
    req.on('data', c => { body += c; if (body.length > 4096) { big = true; } });
    req.on('end', () => {
      if (big) return json(res, 413, { err: 'too large' });
      let b = {}; try { b = JSON.parse(body || '{}'); } catch (e) { return json(res, 400, { err: 'bad json' }); }
      let r; try { r = route(p, b, String(b.dev || '').replace(/[^\w-]/g, '').slice(0, 64)); } catch (e) { console.error(e); r = { status: 500, obj: { err: '서버 오류' } }; }
      json(res, r.status, r.obj);
    
});
    return;
  }
  res.writeHead(404); res.end('not found');
}

/* 연결 유지 핑 + 오래된 세션 정리 */
const pingTimer = setInterval(() => {
  for (const s of sessions.values()) if (s.res) { try { s.res.write(': ping\n\n'); } catch (e) { } }
  const now = Date.now();
  for (const [tok, s] of sessions) if (!s.res && !s.seat && !s.table && now - s.born > 3600e3 && byNick.get(s.nick) !== s) 
sessions.delete(tok);
}, 15000);
pingTimer.unref && pingTimer.unref();

module.exports = { handle, DB, TABLES, sessions, seated, ROOMS: TABLES, flushDB, evalHand, resolve, CARDS, best7, handName, REFILL_TO, START_CHIPS };

if (require.main === module) {
  const server = http.createServer(handle);
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  ♠♥ 포커 LAN 서버가 켜졌습니다 ♦♣\n');
    console.log('  이 PC에서      http://localhost:' + PORT);
    const nets = os.networkInterfaces(); const ips = 
[];
    for (const k of Object.keys(nets)) for (const n of nets[k]) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    if (ips.length) ips.forEach(ip => console.log('  같은 와이파이   http://' + ip + ':' + PORT + '   ← 친구들에게 이 주소를 알려주세요'));
    else console.log('  (네트워크 주소를 찾지 못했습니다. 와이파이 연결을 확인하세요)');
    console.log('\n  종료: Ctrl + C\n');
  });
  const bye = () => { flushDB(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
   }
