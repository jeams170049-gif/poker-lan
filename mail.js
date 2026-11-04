/* ===================== 우편함 + 보석 + 주간 랭킹 (KST 기준) ===================== */
module.exports = function (ctx) {
  const { DB, saveDB } = ctx, nowMs = ctx.now || (() => Date.now());

  /* ---- 여기 숫자만 바꾸면 됩니다 ---- */
  const GEM_CHIPS = 10000000;          // 보석 1개 = 칩 1000만
  const WEEK_MIN_WINS = 3;             // 주간 1등 보상을 받기 위한 최소 승리 수
  const WEEK_GEMS = 1;                 // 주간 랭킹 1등 보석
  const POOP_GEM_RATE = 0.02;          // 돌림판 '꽝(똥)' 이 나왔을 때 보석이 같이 나올 확률 (2%)
  const MAIL_MAX = 60;                 // 우편함 최대 보관 수
  const MAIL_KEEP_DAYS = 30;           // 받은 우편은 30일 뒤 삭제

  DB.meta = DB.meta || {};
  const kst = () => new Date(nowMs() + 9 * 3600e3);
  const weekKey = (t) => {             // 월요일 00시(KST) 기준 주 식별자 (그 주 월요일 날짜)
    const k = new Date((t || nowMs()) + 9 * 3600e3), dow = (k.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() - dow)).toISOString().slice(0, 10);
  };
  const weekResetIn = () => { const k = kst(), dow = (k.getUTCDay() + 6) % 7; return Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() - dow + 7) - k.getTime(); };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* ---- 우편 보내기 ---- */
  function send(nick, o) {
    const rec = DB.players[nick]; if (!rec) return false;
    rec.mail = rec.mail || [];
    rec.mail.unshift({ id: uid(), ts: nowMs(), title: String(o.title || '선물이 도착했어요'), body: String(o.body || ''), gems: o.gems | 0, chips: o.chips | 0, claimed: false });
    prune(rec); saveDB();
    try { ctx.pushLobby && ctx.pushLobby(); } catch (e) { }
    return true;
  }
  function prune(rec) {
    const lim = nowMs() - MAIL_KEEP_DAYS * 86400e3;
    rec.mail = (rec.mail || []).filter(m => !m.claimed || m.ts > lim);
    if (rec.mail.length > MAIL_MAX) {   // 넘치면 받은 우편부터 오래된 순으로 삭제
      const un = rec.mail.filter(m => !m.claimed), cl = rec.mail.filter(m => m.claimed);
      rec.mail = un.concat(cl).slice(0, MAIL_MAX).sort((a, b) => b.ts - a.ts);
    }
  }
  const unread = rec => (rec && rec.mail ? rec.mail.filter(m => !m.claimed).length : 0);
  const gemsOf = rec => (rec && rec.gems) || 0;

  /* ---- 주간 승리 집계 (daily.js 의 event 가 호출) ---- */
  function weekWin(nick, net) {
    try {
      const rec = DB.players[nick]; if (!rec) return;
      const k = weekKey(); if (!rec.wk || rec.wk.k !== k) rec.wk = { k, w: 0, n: 0 };
      rec.wk.w++; rec.wk.n += Math.max(0, net | 0); saveDB();
    } catch (e) { }
  }
  const weekBoard = (k) => Object.values(DB.players).filter(r => r.wk && r.wk.k === k && r.wk.w > 0)
    .sort((a, b) => b.wk.w - a.wk.w || b.wk.n - a.wk.n || (a.created || 0) - (b.created || 0));
  function weekTop(n) { return weekBoard(weekKey()).slice(0, n || 5).map(r => ({ nick: r.nick, w: r.wk.w })); }

  /* 주가 바뀌면 지난주 1등에게 보석 우편 (서버가 꺼져 있었어도 켜질 때 정산) */
  function weekPayout() {
    const cur = weekKey();
    if (!DB.meta.wkSeen) { DB.meta.wkSeen = cur; saveDB(); return; }
    if (DB.meta.wkSeen === cur) return;
    const prev = DB.meta.wkSeen, top = weekBoard(prev)[0];
    DB.meta.wkSeen = cur;
    if (top && top.wk.w >= WEEK_MIN_WINS) {
      send(top.nick, { title: '🏅 주간 랭킹 1위!', body: prev + ' 주 승리 ' + top.wk.w + '회로 1등을 했어요. 축하해요!', gems: WEEK_GEMS });
    }
    saveDB();
  }
  setInterval(weekPayout, 60e3); setTimeout(weekPayout, 3000);

  /* 돌림판 꽝(똥) 보석 */
  function poopDrop(nick) {
    if (Math.random() < POOP_GEM_RATE) { send(nick, { title: '💩 똥 속에서 보석 발견!', body: '돌림판 꽝에서 반짝이는 보석이 나왔어요.', gems: 1 }); return true; }
    return false;
  }

  /* ---- API ---- */
  const view = rec => ({
    gems: gemsOf(rec), rate: GEM_CHIPS, unread: unread(rec),
    mail: (rec.mail || []).slice(0, 40).map(m => ({ id: m.id, ts: m.ts, title: m.title, body: m.body, gems: m.gems, chips: m.chips, claimed: m.claimed })),
    week: { top: weekTop(5), resetIn: weekResetIn(), min: WEEK_MIN_WINS, gems: WEEK_GEMS }
  });
  function handleMail(nick, b) {
    const rec = DB.players[nick]; if (!rec) return { err: '로그인이 필요해요' };
    const a = b.a || 'list';
    if (a === 'list') return { data: view(rec) };
    const give = m => { m.claimed = true; rec.gems = gemsOf(rec) + (m.gems | 0); rec.chips = (rec.chips || 0) + (m.chips | 0); if (m.chips) rec.brokeAt = 0; };
    if (a === 'claim') {
      const m = (rec.mail || []).find(x => x.id === b.id); if (!m) return { err: '없는 우편이에요' };
      if (m.claimed) return { err: '이미 받았어요' };
      give(m); saveDB(); return { chipsChanged: true, data: Object.assign(view(rec), { got: { gems: m.gems | 0, chips: m.chips | 0 } }) };
    }
    if (a === 'claimAll') {
      let g = 0, c = 0; for (const m of rec.mail || []) if (!m.claimed) { g += m.gems | 0; c += m.chips | 0; give(m); }
      if (!g && !c && !(rec.mail || []).length) return { err: '받을 우편이 없어요' };
      saveDB(); return { chipsChanged: true, data: Object.assign(view(rec), { got: { gems: g, chips: c } }) };
    }
    if (a === 'clear') { rec.mail = (rec.mail || []).filter(m => !m.claimed); saveDB(); return { data: view(rec) }; }
    return { err: '알 수 없는 요청' };
  }
  function handleGem(nick, b) {
    const rec = DB.players[nick]; if (!rec) return { err: '로그인이 필요해요' };
    const a = b.a || 'info';
    if (a === 'info') return { data: view(rec) };
    if (a === 'exchange') {
      const n = Math.floor(+b.n);
      if (!(n >= 1 && n <= 1000)) return { err: '교환 개수가 올바르지 않아요' };
      if (gemsOf(rec) < n) return { err: '보석이 부족해요' };
      rec.gems = gemsOf(rec) - n; rec.chips = (rec.chips || 0) + n * GEM_CHIPS; rec.brokeAt = 0; saveDB();
      return { chipsChanged: true, data: Object.assign(view(rec), { got: { chips: n * GEM_CHIPS, spent: n } }) };
    }
    return { err: '알 수 없는 요청' };
  }
  return { send, unread, gemsOf, weekWin, weekTop, poopDrop, handleMail, handleGem, GEM_CHIPS };
};
