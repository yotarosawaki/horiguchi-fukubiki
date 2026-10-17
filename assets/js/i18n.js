// 翻訳の仕組み。文言は assets/lang/ja.js と th.js にあります。
(function () {
  const cfg = window.APP_CONFIG;
  const dicts = window.I18N_DICT || {};
  const param = new URLSearchParams(location.search).get('lang');
  const lang = dicts[param] ? param : (dicts[cfg.lang] ? cfg.lang : 'ja');
  const locale = { ja: 'ja-JP', th: 'th-TH' }[lang] || 'ja-JP';

  function t(key, vars) {
    let s = (dicts[lang] && dicts[lang][key]) ?? (dicts.ja && dicts.ja[key]) ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    return s;
  }

  // HTML の data-i18n 属性を一括で翻訳する
  function apply(root) {
    (root || document).querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    (root || document).querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    (root || document).querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    document.documentElement.lang = lang;
  }

  // 景品名など DB に ja/th 両方入っているものを選ぶ
  function field(obj, name) {
    if (!obj) return '';
    return obj[`${name}_${lang}`] || obj[`${name}_ja`] || '';
  }

  function fmtDate(iso, opts) {
    if (!iso) return '';
    return new Intl.DateTimeFormat(locale, Object.assign({
      timeZone: cfg.timeZone, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }, opts || {})).format(new Date(iso));
  }

  // 有効期限は「翌日0:00まで」で保存しているので、表示は1分前（23:59）にする
  function fmtExpiry(iso) {
    return iso ? fmtDate(new Date(Date.parse(iso) - 60000).toISOString()) : '';
  }

  function errMsg(code) {
    const key = 'err_' + code;
    const s = t(key);
    return s === key ? t('err_unknown') + (code ? ` (${code})` : '') : s;
  }

  window.I18N = { lang, locale, t, apply, field, fmtDate, fmtExpiry, errMsg };
})();
