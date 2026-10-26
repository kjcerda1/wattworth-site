-- WattWorth lead tracking + partner dashboard
-- Run once in the Supabase SQL editor. All access goes through the Vercel API
-- using the service-role key, so RLS is enabled with NO public policies
-- (anon/authenticated roles can read and write nothing directly).

create extension if not exists pgcrypto;

create table if not exists partners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text,
  email text,
  phone text,                      -- E.164, receives SMS alerts
  webhook_url text,                -- optional: push each new lead into the partner's own CRM
  webhook_secret text,             -- HMAC-SHA256 signing secret for webhook payloads
  key_hash text not null unique,   -- sha256 of the dashboard access key (key shown once)
  fee_mode text not null default 'split' check (fee_mode in ('split','flat')),  -- split = your % of his commission; flat = fee by system size
  split_percent numeric check (split_percent >= 0 and split_percent <= 100),    -- YOUR share of his commission on each deal (blank until agreed)
  ads_paid_by text check (ads_paid_by in ('partner','owner')),                  -- who funds the marketing (informational, drives the profit view)
  is_default boolean not null default false,  -- new leads route here
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,                    -- short code both sides can say aloud, e.g. WW-7K2M9Q
  partner_id uuid references partners(id),
  first_name text not null,
  last_name text,
  phone text not null,                         -- E.164
  email text,
  address text, city text, state text, zip text,
  monthly_bill numeric,
  homeowner boolean,
  notes text,
  source text,                                 -- funnel page / campaign
  utm jsonb,
  referrer_code text, referrer_name text,
  -- TCPA consent record, stored verbatim as shown to the consumer
  consent boolean not null,
  consent_text text not null,
  consent_at timestamptz not null default now(),
  consent_ip text, consent_user_agent text,
  -- deal tracking (partner-updatable)
  stage text not null default 'received'
    check (stage in ('received','contacted','appointment_set','proposal_sent','signed','installed','lost','invalid')),
  system_kw numeric,
  contract_value numeric,
  first_contacted_at timestamptz,
  signed_at timestamptz,
  installed_at timestamptz,
  lost_reason text,
  -- bad-lead dispute: partner flags a lead invalid, owner accepts (no fee / credit) or declines
  invalid_reason text,
  dispute_status text check (dispute_status in ('pending','accepted','rejected')),
  dispute_resolved_at timestamptz,
  -- lead-fee tracking (owner-only)
  fee_paid_at timestamptz,                     -- set when your share on this deal is fully received
  commission_cents int check (commission_cents >= 0),            -- total commission the partner's company has earned on this deal (entered by the partner)
  commission_collected_cents int not null default 0,             -- how much of YOUR share you have received so far
  duplicate_of uuid references leads(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists leads_partner_idx on leads(partner_id, created_at desc);
create index if not exists leads_phone_idx on leads(phone);
create index if not exists leads_stage_idx on leads(stage);

-- Every send to a partner, per channel, with outcome and retry state
create table if not exists deliveries (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  partner_id uuid not null references partners(id),
  channel text not null check (channel in ('email','sms','webhook')),
  status text not null default 'queued' check (status in ('queued','sent','failed','skipped')),
  attempts int not null default 0,
  last_error text,
  provider_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists deliveries_lead_idx on deliveries(lead_id);
create index if not exists deliveries_status_idx on deliveries(status);

-- Audit trail: who changed what, when
create table if not exists lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  type text not null,              -- created | stage | size | value | commission | note | delivery | duplicate | fee | payout | dispute
  actor text not null,             -- system | partner:<name> | admin
  from_value text,
  to_value text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists lead_events_lead_idx on lead_events(lead_id, created_at desc);

-- Lead fee tiers by system size. fee_cents stays NULL until you set the agreed amount.
create table if not exists fee_tiers (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  min_kw numeric not null,
  max_kw numeric,                  -- NULL = no upper bound; range is [min_kw, max_kw)
  fee_cents int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Referral program milestones ($50 / $100 / $1,000). Tracking only; payout wording lives in your legal copy.
create table if not exists referral_payouts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  referrer_code text not null,
  milestone text not null check (milestone in ('submitted','estimate','installed')),
  amount_cents int not null,
  status text not null default 'pending' check (status in ('pending','paid')),
  due_at timestamptz,              -- installed milestone: install date + 30 days
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lead_id, milestone)
);

-- Ad spend by month, for cost per lead / cost per signed deal
create table if not exists ad_spend (
  id uuid primary key default gen_random_uuid(),
  month text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),   -- YYYY-MM
  source text,                                                   -- e.g. Meta, Google, Nextdoor
  amount_cents int not null check (amount_cents >= 0),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Alerts already sent (stops the same alert repeating every cron run)
create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table partners enable row level security;
alter table leads enable row level security;
alter table deliveries enable row level security;
alter table lead_events enable row level security;
alter table fee_tiers enable row level security;
alter table referral_payouts enable row level security;
alter table ad_spend enable row level security;
alter table alerts enable row level security;


-- ===== Customer portal (PWA) =====
alter table partners add column if not exists public_phone text;        -- number the customer will see Pedro call from
alter table leads add column if not exists portal_token text unique;     -- private link token (sent only to the customer)
alter table leads add column if not exists own_code text unique;         -- this customer's own referral code
alter table leads add column if not exists appointment_at timestamptz;   -- consultation time set by the partner
alter table leads add column if not exists contact_confirmed text check (contact_confirmed in ('yes','no'));
alter table leads add column if not exists contact_confirmed_at timestamptz;
alter table leads add column if not exists deletion_requested_at timestamptz;
alter table leads add column if not exists portal_link_sent_at timestamptz;

-- Two-way thread between the customer and their solar specialist
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  sender text not null check (sender in ('customer','partner')),
  body text not null,
  via text not null default 'portal' check (via in ('portal','email','dashboard')),
  read_by_customer_at timestamptz,
  read_by_partner_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists messages_lead_idx on messages (lead_id, created_at);

-- Web push subscriptions (one row per installed device)
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  failures int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_lead_idx on push_subscriptions (lead_id);

alter table messages enable row level security;
alter table push_subscriptions enable row level security;

-- Starter tier bands. Amounts intentionally NULL: set them in the admin dashboard once agreed with the partner.
insert into fee_tiers (label, min_kw, max_kw, fee_cents)
select * from (values
  ('Small system', 0::numeric, 7::numeric, null::int),
  ('Mid system',   7::numeric, 11::numeric, null::int),
  ('Large system', 11::numeric, null::numeric, null::int)
) as v(label, min_kw, max_kw, fee_cents)
where not exists (select 1 from fee_tiers);
