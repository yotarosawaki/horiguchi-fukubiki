// サーバー（Supabase の RPC）呼び出し。試用モードでは mock.js に切り替わる。
// どの関数も { ok: true, ... } か { ok: false, error: 'コード' } を返す。
(function () {
  const cfg = window.APP_CONFIG;
  const param = new URLSearchParams(location.search).get('backend');
  let mode = param || cfg.backend;
  if (mode === 'supabase' && !(cfg.supabaseUrl && cfg.supabaseAnonKey)) {
    console.warn('Supabase の設定が空のため試用モードで動きます');
    mode = 'mock';
  }

  async function call(fn, args) {
    if (mode === 'mock') return window.MockBackend.call(fn, args || {});
    const key = cfg.supabaseAnonKey;
    const headers = { 'Content-Type': 'application/json', apikey: key };
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; // 旧形式（JWT）の anon キー
    try {
      const res = await fetch(`${cfg.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers, body: JSON.stringify(args || {}),
      });
      if (!res.ok) {
        console.error(fn, res.status, await res.text());
        return { ok: false, error: 'server' };
      }
      return await res.json();
    } catch (e) {
      console.error(fn, e);
      return { ok: false, error: 'network' };
    }
  }

  window.API = { mode, call };
})();
