// 試用モード用の疑似サーバー。supabase/schema.sql の関数と同じ動きを localStorage 上で再現する。
// 同じブラウザの別タブ（モニター・スタッフ・喫茶店）同士でデータを共有できる。
(function () {
  const KEY = 'hs_mock_db_v1';
  const TZ = 'Asia/Bangkok';
  const PINS = { staff: '111111', cafe: '222222', admin: '999999' };
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function seed() {
    return {
      seq: { prize: 4, draw: 0 },
      settings: { valid_days: 0, event_end: null },
      pins: Object.assign({}, PINS),
      prizes: [
        { id: 1, rank: 1, name_ja: '抹茶ラテ 1杯無料', name_th: 'มัทฉะลาเต้ฟรี 1 แก้ว', note_ja: 'お好きなサイズ', note_th: 'ทุกขนาด', color: '#d4a72c', weight: 5, stock: 30, issued: 0, active: true },
        { id: 2, rank: 2, name_ja: '和菓子プレゼント', name_th: 'รับขนมญี่ปุ่นฟรี', note_ja: 'ドリンクご注文時', note_th: 'เมื่อสั่งเครื่องดื่ม', color: '#c8402f', weight: 15, stock: 100, issued: 0, active: true },
        { id: 3, rank: 3, name_ja: 'ドリンク 20%OFF', name_th: 'ส่วนลดเครื่องดื่ม 20%', note_ja: 'お一人様1回限り', note_th: 'จำกัด 1 ครั้งต่อท่าน', color: '#2f6fb5', weight: 30, stock: null, issued: 0, active: true },
        { id: 4, rank: 4, name_ja: 'ドリンク 10%OFF', name_th: 'ส่วนลดเครื่องดื่ม 10%', note_ja: 'お一人様1回限り', note_th: 'จำกัด 1 ครั้งต่อท่าน', color: '#f4f1ea', weight: 50, stock: null, issued: 0, active: true },
      ],
      coupons: [],
      draws: [],
    };
  }

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || seed(); } catch (e) { return seed(); }
  }
  function save(db) { localStorage.setItem(KEY, JSON.stringify(db)); }

  const err = (code, extra) => Object.assign({ ok: false, error: code }, extra || {});
  const now = () => new Date();
  const randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
  const randInt = (max) => crypto.getRandomValues(new Uint32Array(1))[0] % max;

  // タイ時間の「今日」を YYYY-MM-DD で
  function bkkDate(d) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
  }
  // YYYY-MM-DD + days の 0:00（タイ時間, UTC+7 固定）
  function bkkMidnight(ymd, addDays) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + addDays, 0, 0, 0) - 7 * 3600 * 1000);
  }

  function prizeJson(p) {
    if (!p) return null;
    const { id, rank, name_ja, name_th, note_ja, note_th, color } = p;
    return { id, rank, name_ja, name_th, note_ja, note_th, color };
  }
  function couponJson(db, c, withReceipt) {
    const status = c.voided_at ? 'void' : c.redeemed_at ? 'used' : new Date(c.expires_at) <= now() ? 'expired' : 'valid';
    const o = {
      id: c.id, code: c.code, issued_at: c.issued_at, expires_at: c.expires_at,
      redeemed_at: c.redeemed_at, voided_at: c.voided_at, status,
      prize: prizeJson(db.prizes.find((p) => p.id === c.prize_id)),
    };
    if (withReceipt) o.receipt_no = c.receipt_no;
    return o;
  }
  function drawJson(db, d) {
    const c = db.coupons.find((x) => x.id === d.coupon_id);
    return { id: d.id, receipt_no: d.receipt_no, status: d.status, replay: d.replay, created_at: d.created_at, coupon: couponJson(db, c, true) };
  }

  const handlers = {
    verify_pin(db, a) {
      if (!(a.p_role in db.pins)) return err('bad_role');
      return db.pins[a.p_role] === a.p_pin ? { ok: true } : err('bad_pin');
    },

    public_prizes(db) {
      return { ok: true, prizes: db.prizes.filter((p) => p.active).sort((a, b) => a.rank - b.rank || a.id - b.id).map(prizeJson) };
    },

    get_coupon(db, a) {
      const c = db.coupons.find((x) => x.id === a.p_id);
      return c ? { ok: true, coupon: couponJson(db, c) } : err('not_found');
    },

    issue_draw(db, a) {
      if (db.pins.staff !== a.p_pin) return err('bad_pin');
      const r = String(a.p_receipt || '').replace(/\s/g, '').toUpperCase();
      if (!r) return err('receipt_required');
      if (r.length > 40) return err('receipt_invalid');
      if (db.draws.some((d) => d.receipt_no === r)) return err('receipt_used');
      const today = bkkDate(now());
      const s = db.settings;
      if (s.event_end && today > s.event_end) return err('event_ended');

      const pool = db.prizes.filter((p) => p.active && p.weight > 0 && (p.stock == null || p.issued < p.stock))
        .sort((a, b) => a.rank - b.rank || a.id - b.id);
      const total = pool.reduce((n, p) => n + p.weight, 0);
      if (!total) return err('no_prizes');
      let pick = randInt(total), chosen = pool[0];
      for (const p of pool) { if (pick < p.weight) { chosen = p; break; } pick -= p.weight; }

      let code;
      do { code = Array.from({ length: 6 }, () => ALPHABET[randInt(32)]).join(''); }
      while (db.coupons.some((c) => c.code === code));

      let exp = bkkMidnight(today, s.valid_days + 1);
      if (s.event_end) exp = new Date(Math.min(exp, bkkMidnight(s.event_end, 1)));

      chosen.issued += 1;
      const c = { id: randHex(16), code, prize_id: chosen.id, receipt_no: r, issued_at: now().toISOString(), expires_at: exp.toISOString(), redeemed_at: null, voided_at: null };
      db.coupons.push(c);
      const d = { id: ++db.seq.draw, receipt_no: r, prize_id: chosen.id, coupon_id: c.id, status: 'queued', replay: false, created_at: c.issued_at, shown_at: null };
      db.draws.push(d);
      return { ok: true, draw: drawJson(db, d), queue: db.draws.filter((x) => x.status === 'queued').length };
    },

    monitor_next(db, a) {
      if (db.pins.staff !== a.p_pin) return err('bad_pin');
      const d = db.draws.filter((x) => x.status === 'queued').sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id - y.id)[0];
      if (!d) return { ok: true, draw: null };
      d.status = 'shown'; d.shown_at = now().toISOString();
      return { ok: true, draw: drawJson(db, d) };
    },

    staff_recent(db, a) {
      if (db.pins.staff !== a.p_pin) return err('bad_pin');
      return { ok: true, draws: db.draws.slice().sort((x, y) => y.id - x.id).slice(0, a.p_limit || 30).map((d) => drawJson(db, d)) };
    },

    staff_redisplay(db, a) {
      if (db.pins.staff !== a.p_pin) return err('bad_pin');
      const d = db.draws.find((x) => x.id === a.p_draw_id);
      if (!d) return err('not_found');
      d.status = 'queued'; d.replay = true;
      return { ok: true };
    },

    cafe_check(db, a) {
      if (db.pins.cafe !== a.p_pin) return err('bad_pin');
      const k = String(a.p_key || '').trim().toLowerCase();
      const c = /^[0-9a-f]{32}$/.test(k) ? db.coupons.find((x) => x.id === k) : db.coupons.find((x) => x.code === k.toUpperCase());
      return c ? { ok: true, coupon: couponJson(db, c) } : err('not_found');
    },

    cafe_redeem(db, a) {
      if (db.pins.cafe !== a.p_pin) return err('bad_pin');
      const c = db.coupons.find((x) => x.id === a.p_id);
      if (!c) return err('not_found');
      if (c.redeemed_at || c.voided_at || new Date(c.expires_at) <= now()) return err('not_redeemable', { coupon: couponJson(db, c) });
      c.redeemed_at = now().toISOString();
      return { ok: true, coupon: couponJson(db, c) };
    },

    cafe_recent(db, a) {
      if (db.pins.cafe !== a.p_pin) return err('bad_pin');
      const start = bkkMidnight(bkkDate(now()), 0);
      const used = db.coupons.filter((c) => c.redeemed_at).sort((x, y) => y.redeemed_at.localeCompare(x.redeemed_at));
      return { ok: true, today: used.filter((c) => new Date(c.redeemed_at) >= start).length, coupons: used.slice(0, 20).map((c) => couponJson(db, c)) };
    },

    admin_overview(db, a) {
      if (db.pins.admin !== a.p_pin) return err('bad_pin');
      const start = bkkMidnight(bkkDate(now()), 0);
      return {
        ok: true,
        settings: Object.assign({}, db.settings),
        totals: {
          draws: db.coupons.length,
          draws_today: db.coupons.filter((c) => new Date(c.issued_at) >= start).length,
          redeemed: db.coupons.filter((c) => c.redeemed_at).length,
          redeemed_today: db.coupons.filter((c) => c.redeemed_at && new Date(c.redeemed_at) >= start).length,
        },
        prizes: db.prizes.slice().sort((x, y) => x.rank - y.rank || x.id - y.id).map((p) => Object.assign(prizeJson(p), {
          weight: p.weight, stock: p.stock, issued: p.issued, active: p.active,
          redeemed: db.coupons.filter((c) => c.prize_id === p.id && c.redeemed_at).length,
        })),
      };
    },

    admin_save_prize(db, a) {
      if (db.pins.admin !== a.p_pin) return err('bad_pin');
      const p = a.p_prize || {};
      if (!String(p.name_ja || '').trim()) return err('name_required');
      const rank = parseInt(p.rank, 10), weight = parseInt(p.weight, 10);
      const stock = p.stock === '' || p.stock == null ? null : parseInt(p.stock, 10);
      if (!Number.isFinite(rank) || !(weight >= 0) || (stock !== null && !(stock >= 0))) return err('invalid_input');
      const vals = { rank, weight, stock, name_ja: p.name_ja, name_th: p.name_th || '', note_ja: p.note_ja || '', note_th: p.note_th || '', color: p.color || '#ffffff', active: p.active !== false };
      if (p.id) {
        const cur = db.prizes.find((x) => x.id === Number(p.id));
        if (!cur) return err('not_found');
        Object.assign(cur, vals);
        return { ok: true, id: cur.id };
      }
      const np = Object.assign({ id: ++db.seq.prize, issued: 0 }, vals);
      db.prizes.push(np);
      return { ok: true, id: np.id };
    },

    admin_save_settings(db, a) {
      if (db.pins.admin !== a.p_pin) return err('bad_pin');
      const v = parseInt(a.p_valid_days, 10);
      if (!(v >= 0 && v <= 365)) return err('invalid_input');
      db.settings = { valid_days: v, event_end: a.p_event_end || null };
      return { ok: true };
    },

    admin_coupons(db, a) {
      if (db.pins.admin !== a.p_pin) return err('bad_pin');
      const q = String(a.p_search || '').trim().toUpperCase();
      return {
        ok: true,
        coupons: db.coupons.filter((c) => !q || c.code === q || c.receipt_no.includes(q))
          .sort((x, y) => y.issued_at.localeCompare(x.issued_at)).slice(0, a.p_limit || 200)
          .map((c) => couponJson(db, c, true)),
      };
    },

    admin_void(db, a) {
      if (db.pins.admin !== a.p_pin) return err('bad_pin');
      const c = db.coupons.find((x) => x.id === a.p_id);
      if (!c) return err('not_found');
      c.voided_at = a.p_void ? now().toISOString() : null;
      return { ok: true };
    },

    admin_set_pin(db, a) {
      if (db.pins.admin !== a.p_pin) return err('bad_pin');
      if (!(a.p_role in db.pins)) return err('bad_role');
      if (!/^[0-9]{6,12}$/.test(a.p_new || '')) return err('pin_weak');
      db.pins[a.p_role] = a.p_new;
      return { ok: true };
    },
  };

  async function call(fn, args) {
    await new Promise((r) => setTimeout(r, 120)); // 通信っぽい待ち時間
    const h = handlers[fn];
    if (!h) return err('unknown_function');
    const db = load();
    const res = h(db, args);
    save(db);
    return JSON.parse(JSON.stringify(res));
  }

  function reset() { localStorage.removeItem(KEY); }

  window.MockBackend = { call, reset, PINS };
})();
