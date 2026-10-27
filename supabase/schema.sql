-- WattWorth lead tracking + partner dashboard + customer portal
-- Written for a NEW, dedicated WattWorth Supabase project. Do not run it in any other project.
-- Run once in the Supabase SQL editor. All access goes through the Vercel API using the
-- service-role key (server-side only, never in browser code). Every table has RLS enabled with
-- NO public policies, and anon/authenticated are also stripped of table privileges, so the
-- browser can read and write nothing directly. Electric bills live in a PRIVATE storage bucket.

create extension if not exists pgcrypto with schema extensions;

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
  -- utility verification: at least one COMPLETE method is required (checked by the API and by leads_verification_chk below)
  electric_provider text,
  meter_number text,
  verification_method text check (verification_method in ('bill','meter','both')),
  bill_storage_path text,                      -- object path in the PRIVATE 'electric-bills' bucket. Never a URL, never the file itself.
  bill_filename text,
  bill_mime_type text check (bill_mime_type in ('application/pdf','image/jpeg','image/png')),
  bill_sha256 text,
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
  type text not null,              -- created | stage | size | value | commission | note | delivery | duplicate | fee | reward | referral_override | dispute | bill_view
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

-- Referral program: ONE $1,000 reward per referred lead, only after a verified qualifying installation.
-- A row is the referral record: it exists from attribution (created_at = attribution date) and is worth $0 until the
-- owner verifies the installation, at which point the amount becomes exactly 100000 cents and the status reward_pending.
-- unique(lead_id) makes a second reward for the same referred installation impossible. Status only changes through
-- explicit owner/admin actions (or the partner reporting Installed, which is only a flag); nothing is paid automatically.
create table if not exists referral_rewards (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null unique references leads(id) on delete cascade,   -- the REFERRED lead (one referrer per lead)
  referrer_code text not null,                                           -- the referring customer's own_code
  amount_cents int not null default 0 check (amount_cents in (0, 100000)),
  status text not null default 'tracking'
    check (status in ('tracking','installation_confirmed','reward_pending','paid','ineligible')),
  installation_confirmed_at timestamptz,      -- partner reported the installation (a flag only; earns nothing)
  installation_verified_at timestamptz,       -- owner/admin verified a qualifying installation
  verified_by text,
  reward_pending_at timestamptz,
  paid_at timestamptz,
  paid_by text,                               -- admin actor who recorded the payment
  transaction_ref text,                       -- internal payment reference (check number, transfer id)
  ineligible_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- $1,000 exactly when payable or paid, $0 otherwise
  constraint referral_amount_matches_status check ((status in ('reward_pending','paid')) = (amount_cents = 100000)),
  constraint referral_pending_needs_verification check (status not in ('reward_pending','paid') or (installation_verified_at is not null and reward_pending_at is not null)),
  constraint referral_paid_has_ref check (status <> 'paid' or (paid_at is not null and nullif(trim(transaction_ref), '') is not null and paid_by is not null))
);
create index if not exists referral_rewards_code_idx on referral_rewards(referrer_code);

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
alter table referral_rewards enable row level security;
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


-- ===== Utility verification, for databases that already have a leads table =====
alter table leads add column if not exists electric_provider text;
alter table leads add column if not exists meter_number text;
alter table leads add column if not exists verification_method text;
alter table leads add column if not exists bill_storage_path text;
alter table leads add column if not exists bill_filename text;
alter table leads add column if not exists bill_mime_type text;
alter table leads add column if not exists bill_sha256 text;
-- NOT VALID: enforced for every new or changed row, without failing on any older rows.
do $$ begin
  alter table leads add constraint leads_verification_chk check (
    verification_method is not null and verification_method in ('bill','meter','both')
    and ((electric_provider is null) = (meter_number is null))
    and (verification_method = 'bill' or (nullif(trim(electric_provider), '') is not null and nullif(trim(meter_number), '') is not null))
    and (verification_method = 'meter' or bill_sha256 is not null)
    and (bill_storage_path is null or bill_storage_path like 'bills/%')
  ) not valid;
exception when duplicate_object then null; end $$;

-- ===== Private storage for electric bills =====
-- Private bucket, 3 MB limit, PDF/JPG/PNG only. The API uploads and reads with the service role.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('electric-bills', 'electric-bills', false, 3145728, array['application/pdf','image/jpeg','image/png'])
on conflict (id) do update set public = false, file_size_limit = 3145728,
  allowed_mime_types = array['application/pdf','image/jpeg','image/png'];

-- storage.objects already has RLS enabled by Supabase. This RESTRICTIVE policy is ANDed with any policy that
-- anyone adds later: the browser roles can never touch this bucket, even if a broad permissive policy is created.
drop policy if exists electric_bills_no_client_access on storage.objects;
create policy electric_bills_no_client_access on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'electric-bills') with check (bucket_id <> 'electric-bills');

-- ===== Defense in depth: the browser roles get no table privileges at all =====
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
