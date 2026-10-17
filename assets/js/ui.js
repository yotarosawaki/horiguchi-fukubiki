// 画面共通の部品: 端末のPIN設定、トースト、QRコード、HTMLエスケープなど
(function () {
  const { t } = window.I18N;
  const pinKey = (role) => `hs_pin_${role}`;

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function storedPin(role) {
    try { return localStorage.getItem(pinKey(role)); } catch (e) { return null; }
  }
  function forgetPin(role) {
    try { localStorage.removeItem(pinKey(role)); } catch (e) { /* noop */ }
  }

  // 端末にPINが保存されていなければ入力画面を出す。正しいPINで resolve。
  function requirePin(role) {
    const saved = storedPin(role);
    if (saved) return Promise.resolve(saved);
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'pin-overlay';
      wrap.innerHTML = `
        <form class="pin-card">
          <div class="brand-mark">${esc(t('brand'))}</div>
          <h1>${esc(t('pin_title_' + role))}</h1>
          <label for="pin-input">${esc(t('pin_label'))}</label>
          <input id="pin-input" type="password" inputmode="numeric" autocomplete="off" required>
          <p class="pin-error" role="alert"></p>
          <button type="submit" class="btn btn-primary btn-lg">${esc(t('pin_submit'))}</button>
          ${window.API.mode === 'mock' ? `<p class="muted small">${esc(t('mock_pin_hint', { pin: window.MockBackend.PINS[role] }))}</p>` : ''}
        </form>`;
      document.body.appendChild(wrap);
      const form = wrap.querySelector('form');
      const input = wrap.querySelector('input');
      const errEl = wrap.querySelector('.pin-error');
      input.focus();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const pin = input.value.trim();
        const res = await window.API.call('verify_pin', { p_role: role, p_pin: pin });
        if (!res.ok) { errEl.textContent = window.I18N.errMsg(res.error); input.select(); return; }
        try { localStorage.setItem(pinKey(role), pin); } catch (e2) { /* noop */ }
        wrap.remove();
        resolve(pin);
      });
    });
  }

  // PIN が変更された・間違っていたときは端末設定をやり直す
  function isAuthError(res) {
    return res && !res.ok && ['bad_pin', 'pin_not_set'].includes(res.error);
  }
  function resetDevice(role) {
    forgetPin(role);
    location.reload();
  }

  let toastTimer;
  function toast(msg, type) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg;
    el.dataset.type = type || 'info';
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  // QR を SVG 文字列で作る（qrcode-generator ライブラリを使用）
  function qrSvg(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount(), m = 4, size = n + m * 2;
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m},${r + m}h1v1h-1z`;
    return `<svg class="qr" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  // お客様用クーポンページのURL（言語・試用モードの指定を引き継ぐ）
  function couponUrl(id) {
    const u = new URL('coupon.html', location.href);
    u.search = '';
    u.searchParams.set('c', id);
    const cur = new URLSearchParams(location.search);
    ['lang', 'backend'].forEach((k) => { if (cur.get(k)) u.searchParams.set(k, cur.get(k)); });
    return u.toString();
  }

  function rankLabel(rank) { return t('rank_label', { rank }); }

  // 玉の色が明るいときは文字を濃くする
  function inkFor(hex) {
    const h = String(hex || '#fff').replace('#', '');
    const v = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.substr(i, 2), 16) || 0);
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#1f2a22' : '#ffffff';
  }

  function mockBadge() {
    if (window.API.mode !== 'mock') return;
    const b = document.createElement('div');
    b.className = 'mock-badge';
    b.textContent = t('mock_notice');
    document.body.appendChild(b);
  }

  window.UI = { esc, requirePin, storedPin, forgetPin, isAuthError, resetDevice, toast, qrSvg, couponUrl, rankLabel, inkFor, mockBadge };
})();
