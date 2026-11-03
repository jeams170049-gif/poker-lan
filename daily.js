/* ===================== 출석 보상 + 일일 미션 (KST 00시 기준) ===================== */
module.exports = function (ctx) {
  const { DB, saveDB } = ctx, nowMs = ctx.now || (() => Date.now());

  /* ---- 보상 금액: 여기 숫자만 바꾸면 됩니다 ---- */
  const ATT_NORMAL = 1000000;                                   // 평소 출석 보상
  const ATT_SPECIAL = { 10: 3000000, 20: 5000000, 30: 10000000 }; // 10일 단위 특별 보상
  const MS_REWARD = { 하: 100000, 중: 500000, 상: 1000000 };      // 미션 난이도별 보상
  const ALL_CLEAR = 2000000;                                    // 5개 모두 클리어 보상
  const ATT_MAX = 30;

  const attReward = d => ATT_SPECIAL[d] || ATT_NORMAL;
  const kst = () => new Date(nowMs() + 9 * 3600e3);
  const ymd = () => kst().toISOString().slice(0, 10);
  const ym = () => kst().toISOString().slice(0, 7);
  const daysInMonth = () => { const k = kst(); return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth() + 1, 0)).getUTCDate(); };
  const resetIn = () => { const k = kst(); return Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() + 1) - k.getTime(); };

  /* ---- 미션 풀 (key = 집계 항목, t = 목표 횟수) ---- */
  const POOL = {
    하: [
      { key: 'hand', t: 3, tx: '아무 게임 3판 플레이하기' },
      { key: 'hand_holdem', t: 2, tx: '텍사스 홀덤 2판 플레이하기' },
      { key: 'hand_seotda', t: 2, tx: '섯다 2판 플레이하기' },
      { key: 'hand_gostop', t: 1, tx: '맞고 1판 플레이하기' },
      { key: 'mini', t: 3, tx: '미니게임 3회 하기' },
      { key: 'chat', t: 3, tx: '채팅 3번 보내기' },
    ],
    중: [
      { key: 'win', t: 2, tx: '아무 게임 2번 이기기' },
      { key: 'win_holdem', t: 1, tx: '텍사스 홀덤 1번 이기기' },
      { key: 'win_seotda', t: 1, tx: '섯다 1번 이기기' },
      { key: 'win_gostop', t: 1, tx: '맞고 1번 이기기' },
      { key: 'mini', t: 7, tx: '미니게임 7회 하기' },
      { key: 'hand', t: 8, tx: '아무 게임 8판 플레이하기' },
    ],
    상: [
      { key: 'win', t: 5, tx: '아무 게임 5번 이기기' },
      { key: 'bigwin', t: 1, tx: '한 판에서 칩 200만 이상 따기' },
      { key: 'win_gostop', t: 2, tx: '맞고 2번 이기기' },
      { key: 'hand', t: 15, tx: '아무 게임 15판 플레이하기' },
      { key: 'minihit', t: 1, tx: '미니게임에서 5배 이상 당첨되기' },
    ],
  };
  function rng(seedStr) { let h = 2166136261; for (const c of seedStr) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } let a = h >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  let cacheDay = '', cacheSet = [];
  function todaySet() {   // 매일 00시(KST)에 새로 짜임 — 날짜가 같으면 모든 유저가 같은 미션
    const d = ymd(); if (cacheDay === d) return cacheSet;
    const r = rng('mission-' + d), used = new Set(), out = [];
    for (const [lv, n] of [['하', 2], ['중', 2], ['상', 1]]) {
      const pool = POOL[lv].slice(); let k = 0;
      while (k < n && pool.length) {
        const i = Math.floor(r() * pool.length), m = pool.splice(i, 1)[0];
        const sig = m.key; if (used.has(sig) && pool.length) continue;   // 같은 종류 중복 피하기
        used.add(sig); out.push({ id: lv + k, lv, key: m.key, t: m.t, tx: m.tx, reward: MS_REWARD[lv] }); k++;
      }
    }
    cacheDay = d; cacheSet = out; return out;
  }

  const attOf = rec => { const m = ym(); if (!rec.att || rec.att.m !== m) rec.att = { m, n: 0, last: '' }; return rec.att; };
  const msOf = rec => { const d = ymd(); if (!rec.ms || rec.ms.d !== d) rec.ms = { d, p: {}, c: {}, all: false }; return rec.ms; };

  /* ---- 게임에서 호출: 진행도 집계 ---- */
  function event(nick, type, o) {
    try {
      const rec = DB.players[nick]; if (!rec) return; o = o || {};
      const ms = msOf(rec), p = ms.p, add = k => { p[k] = (p[k] || 0) + 1; };
      if (type === 'hand') {
        add('hand'); if (o.game) add('hand_' + o.game);
        if (o.win) { add('win'); if (o.game) add('win_' + o.game); }
        if ((o.net || 0) >= 2000000) add('bigwin');
      } else if (type === 'mini') { add('mini'); if ((o.mult || 0) >= 5) add('minihit'); }
      else if (type === 'chat') add('chat');
      saveDB();
    } catch (e) { }
  }

  function info(nick) {
    const rec = DB.players[nick], att = attOf(rec), ms = msOf(rec), today = ymd();
    const max = Math.min(ATT_MAX, daysInMonth()), claimedToday = att.last === today;
    const list = todaySet().map(m => { const prog = Math.min(m.t, ms.p[m.key] || 0); return { id: m.id, lv: m.lv, tx: m.tx, t: m.t, prog, reward: m.reward, done: prog >= m.t, claimed: !!ms.c[m.id] }; });
    const rewards = []; for (let d = 1; d <= ATT_MAX; d++) rewards.push(attReward(d));
    return {
      today, resetIn: resetIn(),
      att: { month: att.m, n: att.n, max, claimedToday, can: !claimedToday && att.n < max, next: att.n + 1, rewards },
      ms: { list, allDone: list.every(x => x.done), allClaimed: !!ms.all, allReward: ALL_CLEAR },
      canAny: (!claimedToday && att.n < max) || list.some(x => x.done && !x.claimed) || (list.every(x => x.done && x.claimed) && !ms.all),
    };
  }

  /* ---- API ---- */
  function handle(nick, b) {
    const rec = DB.players[nick]; if (!rec) return { err: '로그인이 필요해요' };
    const a = b.a || 'info';
    if (a === 'info') return { data: info(nick) };
    if (a === 'attend') {
      const att = attOf(rec), today = ymd(), max = Math.min(ATT_MAX, daysInMonth());
      if (att.last === today) return { err: '오늘은 이미 출석했어요' };
      if (att.n >= max) return { err: '이번 달 출석을 모두 마쳤어요' };
      const day = att.n + 1, amt = attReward(day);
      att.n = day; att.last = today; rec.chips = (rec.chips || 0) + amt; rec.brokeAt = 0; saveDB();
      return { chipsChanged: true, data: Object.assign(info(nick), { got: amt, day }) };
    }
    if (a === 'mission') {
      const ms = msOf(rec), m = todaySet().find(x => x.id === b.id);
      if (!m) return { err: '없는 미션이에요' };
      if (ms.c[m.id]) return { err: '이미 받았어요' };
      if ((ms.p[m.key] || 0) < m.t) return { err: '아직 달성하지 못했어요' };
      ms.c[m.id] = true; rec.chips = (rec.chips || 0) + m.reward; rec.brokeAt = 0; saveDB();
      return { chipsChanged: true, data: Object.assign(info(nick), { got: m.reward }) };
    }
    if (a === 'all') {
      const ms = msOf(rec), set = todaySet();
      if (ms.all) return { err: '올 클리어 보상을 이미 받았어요' };
      if (!set.every(m => ms.c[m.id])) return { err: '5개 미션의 보상을 모두 받아야 해요' };
      ms.all = true; rec.chips = (rec.chips || 0) + ALL_CLEAR; rec.brokeAt = 0; saveDB();
      return { chipsChanged: true, data: Object.assign(info(nick), { got: ALL_CLEAR }) };
    }
    return { err: '알 수 없는 요청' };
  }
  return { event, handle, info, _todaySet: todaySet };
};
