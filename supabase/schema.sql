-- =====================================================================
-- 堀口製茶 × ICONSIAM 高島屋  福引クーポン  データベース定義
-- Supabase の SQL Editor に全文を貼り付けて実行してください。
-- 何度実行しても壊れないように作ってあります（データは消えません）。
--
-- 方針:
--   * テーブルはブラウザから直接読み書きできない（RLS有効・権限なし）
--   * 画面からの操作はすべて下の関数（RPC）経由。関数の中で PIN を確認する
--   * 抽選結果・在庫・クーポンの使用済み判定はすべてサーバー側で行う
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables

create table if not exists public.settings (
  id          int primary key default 1 check (id = 1),
  valid_days  int  not null default 0 check (valid_days between 0 and 365), -- 0 = 発行当日のみ
  event_end   date,                                                         -- イベント最終日（null = 制限なし）
  updated_at  timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict do nothing;

create table if not exists public.app_pins (
  role     text primary key check (role in ('staff', 'cafe', 'admin')),
  pin_hash text not null
);

create table if not exists public.pin_failures (
  id   bigserial primary key,
  role text not null,
  at   timestamptz not null default now()
);

create table if not exists public.prizes (
  id         serial primary key,
  rank       int  not null default 1,          -- 1等, 2等 …（表示順も兼ねる）
  name_ja    text not null,
  name_th    text not null default '',
  note_ja    text not null default '',
  note_th    text not null default '',
  color      text not null default '#ffffff',  -- 福引の玉の色
  weight     int  not null default 1 check (weight >= 0),        -- 当選比率
  stock      int  check (stock is null or stock >= 0),           -- 発行上限（null = 無制限）
  issued     int  not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.coupons (
  id          text primary key,                -- 推測不能な32桁のランダムID（QRの中身）
  code        text not null unique,            -- 6文字の確認コード（手入力用）
  prize_id    int  not null references public.prizes (id),
  receipt_no  text not null,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  redeemed_at timestamptz,
  voided_at   timestamptz
);

create table if not exists public.draws (
  id         bigserial primary key,
  receipt_no text not null unique,             -- 同じレシートで2回は引けない
  prize_id   int  not null references public.prizes (id),
  coupon_id  text not null references public.coupons (id),
  status     text not null default 'queued' check (status in ('queued', 'shown')),
  replay     boolean not null default false,
  created_at timestamptz not null default now(),
  shown_at   timestamptz
);

create index if not exists draws_status_idx     on public.draws (status, created_at);
create index if not exists coupons_issued_idx   on public.coupons (issued_at desc);
create index if not exists coupons_redeemed_idx on public.coupons (redeemed_at desc);
create index if not exists pin_failures_idx     on public.pin_failures (role, at);

alter table public.settings     enable row level security;
alter table public.app_pins     enable row level security;
alter table public.pin_failures enable row level security;
alter table public.prizes       enable row level security;
alter table public.coupons      enable row level security;
alter table public.draws        enable row level security;

-- 初期景品（仮）。管理画面から変更できます。景品が1件もないときだけ入ります。
insert into public.prizes (rank, name_ja, name_th, note_ja, note_th, color, weight, stock)
select * from (values
  (1, '抹茶ラテ 1杯無料',   'มัทฉะลาเต้ฟรี 1 แก้ว',     'お好きなサイズ',     'ทุกขนาด',             '#d4a72c',  5,   30),
  (2, '和菓子プレゼント',   'รับขนมญี่ปุ่นฟรี',          'ドリンクご注文時',   'เมื่อสั่งเครื่องดื่ม', '#c8402f', 15,  100),
  (3, 'ドリンク 20%OFF',    'ส่วนลดเครื่องดื่ม 20%',     'お一人様1回限り',     'จำกัด 1 ครั้งต่อท่าน', '#2f6fb5', 30, null),
  (4, 'ドリンク 10%OFF',    'ส่วนลดเครื่องดื่ม 10%',     'お一人様1回限り',     'จำกัด 1 ครั้งต่อท่าน', '#f4f1ea', 50, null)
) as v (rank, name_ja, name_th, note_ja, note_th, color, weight, stock)
where not exists (select 1 from public.prizes);

-- ---------------------------------------------------------------- helpers (内部用)

create or replace function public._check_pin(p_role text, p_pin text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare h text; fails int;
begin
  select count(*) into fails from pin_failures
   where role = p_role and at > now() - interval '5 minutes';
  if fails >= 50 then return 'locked'; end if;
  select pin_hash into h from app_pins where role = p_role;
  if h is null then return 'pin_not_set'; end if;
  if crypt(coalesce(p_pin, ''), h) = h then return null; end if;
  insert into pin_failures (role) values (p_role);
  return 'bad_pin';
end $$;

create or replace function public._err(p_code text)
returns jsonb language sql immutable as $$
  select jsonb_build_object('ok', false, 'error', p_code)
$$;

create or replace function public._prize_json(p public.prizes)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', p.id, 'rank', p.rank, 'name_ja', p.name_ja, 'name_th', p.name_th,
                            'note_ja', p.note_ja, 'note_th', p.note_th, 'color', p.color)
$$;

-- クーポンの状態: valid / used / expired / void
create or replace function public._coupon_json(c public.coupons, p_with_receipt boolean default false)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', c.id, 'code', c.code, 'issued_at', c.issued_at, 'expires_at', c.expires_at,
    'redeemed_at', c.redeemed_at, 'voided_at', c.voided_at,
    'status', case when c.voided_at is not null then 'void'
                   when c.redeemed_at is not null then 'used'
                   when c.expires_at <= now() then 'expired'
                   else 'valid' end,
    'prize', (select public._prize_json(p) from prizes p where p.id = c.prize_id)
  ) || case when p_with_receipt then jsonb_build_object('receipt_no', c.receipt_no) else '{}'::jsonb end
$$;

create or replace function public._draw_json(p_id bigint)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('id', d.id, 'receipt_no', d.receipt_no, 'status', d.status, 'replay', d.replay,
                            'created_at', d.created_at, 'coupon', public._coupon_json(c, true))
    from draws d join coupons c on c.id = d.coupon_id
   where d.id = p_id
$$;

create or replace function public.set_pin(p_role text, p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pin !~ '^[0-9]{6,12}$' then raise exception 'PIN must be 6-12 digits'; end if;
  insert into app_pins (role, pin_hash) values (p_role, crypt(p_pin, gen_salt('bf', 8)))
  on conflict (role) do update set pin_hash = excluded.pin_hash;
  delete from pin_failures where role = p_role;
end $$;

-- ---------------------------------------------------------------- 共通・公開

create or replace function public.verify_pin(p_role text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare err text;
begin
  if p_role not in ('staff', 'cafe', 'admin') then return _err('bad_role'); end if;
  err := _check_pin(p_role, p_pin);
  if err is not null then return _err(err); end if;
  return jsonb_build_object('ok', true);
end $$;

-- モニターの待機画面に出す景品一覧（在庫数などは出さない）
create or replace function public.public_prizes()
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object('ok', true, 'prizes',
    coalesce(jsonb_agg(public._prize_json(p) order by p.rank, p.id), '[]'::jsonb))
    from prizes p where p.active
$$;

-- お客様のクーポン画面（IDを知っている人だけが見られる。レシート番号は返さない）
create or replace function public.get_coupon(p_id text)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare c coupons;
begin
  if p_id !~ '^[0-9a-f]{32}$' then return _err('not_found'); end if;
  select * into c from coupons where id = p_id;
  if not found then return _err('not_found'); end if;
  return jsonb_build_object('ok', true, 'coupon', _coupon_json(c));
end $$;

-- ---------------------------------------------------------------- 売場スタッフ・モニター

create or replace function public.issue_draw(p_pin text, p_receipt text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  tz constant text := 'Asia/Bangkok';
  err text; r text; s settings; total bigint; pick bigint; acc bigint := 0;
  pr record; chosen int; ccode text; cid text; exp timestamptz; d_id bigint;
begin
  err := _check_pin('staff', p_pin);
  if err is not null then return _err(err); end if;

  r := upper(regexp_replace(coalesce(p_receipt, ''), '\s', '', 'g'));
  if r = '' then return _err('receipt_required'); end if;
  if length(r) > 40 then return _err('receipt_invalid'); end if;
  if exists (select 1 from draws where receipt_no = r) then return _err('receipt_used'); end if;

  select * into s from settings where id = 1;
  if s.event_end is not null and (now() at time zone tz)::date > s.event_end then
    return _err('event_ended');
  end if;

  -- 在庫の取り合いを防ぐため景品行をロック
  perform 1 from prizes where active for update;
  select coalesce(sum(weight), 0) into total from prizes
   where active and weight > 0 and (stock is null or issued < stock);
  if total = 0 then return _err('no_prizes'); end if;

  pick := ('x' || encode(gen_random_bytes(6), 'hex'))::bit(48)::bigint % total;
  for pr in select id, weight from prizes
             where active and weight > 0 and (stock is null or issued < stock)
             order by rank, id loop
    acc := acc + pr.weight;
    if pick < acc then chosen := pr.id; exit; end if;
  end loop;

  loop
    ccode := '';
    for i in 1..6 loop
      ccode := ccode || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + get_byte(gen_random_bytes(1), 0) % 32, 1);
    end loop;
    exit when not exists (select 1 from coupons where code = ccode);
  end loop;
  cid := encode(gen_random_bytes(16), 'hex');

  exp := ((now() at time zone tz)::date + s.valid_days + 1)::timestamp at time zone tz;
  if s.event_end is not null then
    exp := least(exp, (s.event_end + 1)::timestamp at time zone tz);
  end if;

  begin
    update prizes set issued = issued + 1 where id = chosen;
    insert into coupons (id, code, prize_id, receipt_no, expires_at) values (cid, ccode, chosen, r, exp);
    insert into draws (receipt_no, prize_id, coupon_id) values (r, chosen, cid) returning id into d_id;
  exception when unique_violation then
    return _err('receipt_used');
  end;

  return jsonb_build_object('ok', true, 'draw', _draw_json(d_id),
    'queue', (select count(*) from draws where status = 'queued'));
end $$;

-- モニターが次に表示する抽選を1件取り出す
create or replace function public.monitor_next(p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare err text; d_id bigint;
begin
  err := _check_pin('staff', p_pin);
  if err is not null then return _err(err); end if;
  select id into d_id from draws where status = 'queued'
   order by created_at, id limit 1 for update skip locked;
  if d_id is null then return jsonb_build_object('ok', true, 'draw', null); end if;
  update draws set status = 'shown', shown_at = now() where id = d_id;
  return jsonb_build_object('ok', true, 'draw', _draw_json(d_id));
end $$;

create or replace function public.staff_recent(p_pin text, p_limit int default 30)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare err text;
begin
  err := _check_pin('staff', p_pin);
  if err is not null then return _err(err); end if;
  return jsonb_build_object('ok', true, 'draws', coalesce((
    select jsonb_agg(_draw_json(x.id) order by x.id desc)
      from (select id from draws order by id desc limit least(greatest(p_limit, 1), 100)) x
  ), '[]'::jsonb));
end $$;

-- お客様がQRを撮り逃したとき、モニターにもう一度出す（抽選はやり直さない）
create or replace function public.staff_redisplay(p_pin text, p_draw_id bigint)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare err text;
begin
  err := _check_pin('staff', p_pin);
  if err is not null then return _err(err); end if;
  update draws set status = 'queued', replay = true where id = p_draw_id;
  if not found then return _err('not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- 喫茶店

-- p_key は QR の中身（32桁ID）または 6文字コード
create or replace function public.cafe_check(p_pin text, p_key text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare err text; k text; c coupons;
begin
  err := _check_pin('cafe', p_pin);
  if err is not null then return _err(err); end if;
  k := lower(trim(coalesce(p_key, '')));
  if k ~ '^[0-9a-f]{32}$' then
    select * into c from coupons where id = k;
  else
    select * into c from coupons where code = upper(k);
  end if;
  if not found then return _err('not_found'); end if;
  return jsonb_build_object('ok', true, 'coupon', _coupon_json(c));
end $$;

-- 消し込み。条件付き UPDATE 1回で行うので、2台同時に押しても1回しか成功しない
create or replace function public.cafe_redeem(p_pin text, p_id text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare err text; c coupons;
begin
  err := _check_pin('cafe', p_pin);
  if err is not null then return _err(err); end if;
  update coupons set redeemed_at = now()
   where id = p_id and redeemed_at is null and voided_at is null and expires_at > now()
  returning * into c;
  if not found then
    select * into c from coupons where id = p_id;
    if not found then return _err('not_found'); end if;
    return jsonb_build_object('ok', false, 'error', 'not_redeemable', 'coupon', _coupon_json(c));
  end if;
  return jsonb_build_object('ok', true, 'coupon', _coupon_json(c));
end $$;

create or replace function public.cafe_recent(p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare err text; tz constant text := 'Asia/Bangkok'; day_start timestamptz;
begin
  err := _check_pin('cafe', p_pin);
  if err is not null then return _err(err); end if;
  day_start := ((now() at time zone tz)::date)::timestamp at time zone tz;
  return jsonb_build_object('ok', true,
    'today', (select count(*) from coupons where redeemed_at >= day_start),
    'coupons', coalesce((select jsonb_agg(_coupon_json(c) order by c.redeemed_at desc)
                           from coupons c
                          where c.id in (select id from coupons where redeemed_at is not null
                                          order by redeemed_at desc limit 20)), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- 管理

create or replace function public.admin_overview(p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare err text; tz constant text := 'Asia/Bangkok'; day_start timestamptz;
begin
  err := _check_pin('admin', p_pin);
  if err is not null then return _err(err); end if;
  day_start := ((now() at time zone tz)::date)::timestamp at time zone tz;
  return jsonb_build_object('ok', true,
    'settings', (select jsonb_build_object('valid_days', valid_days, 'event_end', event_end) from settings where id = 1),
    'totals', jsonb_build_object(
      'draws',          (select count(*) from coupons),
      'draws_today',    (select count(*) from coupons where issued_at >= day_start),
      'redeemed',       (select count(*) from coupons where redeemed_at is not null),
      'redeemed_today', (select count(*) from coupons where redeemed_at >= day_start)),
    'prizes', coalesce((
      select jsonb_agg(_prize_json(p) || jsonb_build_object(
               'weight', p.weight, 'stock', p.stock, 'issued', p.issued, 'active', p.active,
               'redeemed', (select count(*) from coupons c where c.prize_id = p.id and c.redeemed_at is not null))
             order by p.rank, p.id)
        from prizes p), '[]'::jsonb));
end $$;

create or replace function public.admin_save_prize(p_pin text, p_prize jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare err text; pid int;
begin
  err := _check_pin('admin', p_pin);
  if err is not null then return _err(err); end if;
  if coalesce(trim(p_prize->>'name_ja'), '') = '' then return _err('name_required'); end if;
  pid := nullif(p_prize->>'id', '')::int;
  if pid is null then
    insert into prizes (rank, name_ja, name_th, note_ja, note_th, color, weight, stock, active)
    values ((p_prize->>'rank')::int, p_prize->>'name_ja', coalesce(p_prize->>'name_th', ''),
            coalesce(p_prize->>'note_ja', ''), coalesce(p_prize->>'note_th', ''),
            coalesce(p_prize->>'color', '#ffffff'), (p_prize->>'weight')::int,
            nullif(p_prize->>'stock', '')::int, coalesce((p_prize->>'active')::boolean, true))
    returning id into pid;
  else
    update prizes set
      rank = (p_prize->>'rank')::int, name_ja = p_prize->>'name_ja', name_th = coalesce(p_prize->>'name_th', ''),
      note_ja = coalesce(p_prize->>'note_ja', ''), note_th = coalesce(p_prize->>'note_th', ''),
      color = coalesce(p_prize->>'color', '#ffffff'), weight = (p_prize->>'weight')::int,
      stock = nullif(p_prize->>'stock', '')::int, active = coalesce((p_prize->>'active')::boolean, true)
    where id = pid;
  end if;
  return jsonb_build_object('ok', true, 'id', pid);
exception when others then
  return _err('invalid_input');
end $$;

create or replace function public.admin_save_settings(p_pin text, p_valid_days int, p_event_end date)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare err text;
begin
  err := _check_pin('admin', p_pin);
  if err is not null then return _err(err); end if;
  update settings set valid_days = p_valid_days, event_end = p_event_end, updated_at = now() where id = 1;
  return jsonb_build_object('ok', true);
exception when others then
  return _err('invalid_input');
end $$;

create or replace function public.admin_coupons(p_pin text, p_search text default '', p_limit int default 200)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare err text; q text;
begin
  err := _check_pin('admin', p_pin);
  if err is not null then return _err(err); end if;
  q := upper(trim(coalesce(p_search, '')));
  return jsonb_build_object('ok', true, 'coupons', coalesce((
    select jsonb_agg(_coupon_json(c, true) order by c.issued_at desc)
      from coupons c
     where c.id in (select id from coupons
                     where q = '' or code = q or receipt_no like '%' || q || '%'
                     order by issued_at desc limit least(greatest(p_limit, 1), 5000))
  ), '[]'::jsonb));
end $$;

create or replace function public.admin_void(p_pin text, p_id text, p_void boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare err text;
begin
  err := _check_pin('admin', p_pin);
  if err is not null then return _err(err); end if;
  update coupons set voided_at = case when p_void then now() else null end where id = p_id;
  if not found then return _err('not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_set_pin(p_pin text, p_role text, p_new text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare err text;
begin
  err := _check_pin('admin', p_pin);
  if err is not null then return _err(err); end if;
  if p_role not in ('staff', 'cafe', 'admin') then return _err('bad_role'); end if;
  if coalesce(p_new, '') !~ '^[0-9]{6,12}$' then return _err('pin_weak'); end if;
  perform set_pin(p_role, p_new);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- 権限

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.verify_pin(text, text),
  public.public_prizes(),
  public.get_coupon(text),
  public.issue_draw(text, text),
  public.monitor_next(text),
  public.staff_recent(text, int),
  public.staff_redisplay(text, bigint),
  public.cafe_check(text, text),
  public.cafe_redeem(text, text),
  public.cafe_recent(text),
  public.admin_overview(text),
  public.admin_save_prize(text, jsonb),
  public.admin_save_settings(text, int, date),
  public.admin_coupons(text, text, int),
  public.admin_void(text, text, boolean),
  public.admin_set_pin(text, text, text)
to anon;

-- =====================================================================
-- 最後に、PIN を3つ設定してください（6〜12桁の数字。推測されにくいもの）。
-- 下の3行の数字を書き換えてから、この3行だけを選んで実行します。
--
--   select public.set_pin('staff', '売場スタッフ用のPIN');
--   select public.set_pin('cafe',  '喫茶店用のPIN');
--   select public.set_pin('admin', '管理者用のPIN');
-- =====================================================================
