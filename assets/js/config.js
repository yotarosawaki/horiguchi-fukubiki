// =====================================================================
// 設定ファイル（ここだけ書き換えれば動きます）
// =====================================================================
window.APP_CONFIG = {
  // 'mock'     … 試用モード。サーバー不要で、このブラウザの中だけで動きます（データは他の端末と共有されません）
  // 'supabase' … 本番。下の supabaseUrl / supabaseAnonKey を入れてください
  backend: 'supabase',

  // Supabase の Project Settings → API に表示される値
  supabaseUrl: 'https://vdkzeugnekgviqtxwreb.supabase.co',
  supabaseAnonKey: 'sb_publishable_s0Gp8b3pX2lcrmN5saSzpw_oODAv7vy', // 公開用キー（公開してよい種類）

  // 表示言語。納品時に 'th' にするとタイ語になります（URL に ?lang=th を付けても切替可）
  lang: 'ja',

  timeZone: 'Asia/Bangkok',

  // モニターに当選結果（クーポンQR）を表示しておく秒数
  monitorResultSeconds: 90,

  // モニターが新しい抽選を確認する間隔（ミリ秒）
  pollMs: 2000,
};
