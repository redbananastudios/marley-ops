-- Growth Suite artifact mirror: the RBS-OS agent suite on i9 exports
-- propose-only JSON artifacts (ops snapshot, funnel export, ad proposals,
-- tracking specs). A push script upserts the latest of each per brand here so
-- the /growth pages can read them. Marley Ops never reads the agents' DB —
-- this table IS the JSON hand-off, one row per (brand, artifact_type).

create table if not exists public.growth_artifacts (
  id            uuid primary key default gen_random_uuid(),
  brand         text not null,
  artifact_type text not null,                       -- e.g. 'marley_ops_snapshot', 'ads_creative_matrix'
  generated_at  timestamptz,                         -- when the agent built the artifact (from its JSON)
  pushed_at     timestamptz not null default now(),  -- when i9 last pushed it
  source_host   text,                                -- e.g. 'i9'
  payload       jsonb not null,
  unique (brand, artifact_type)
);

create index if not exists growth_artifacts_brand_idx on public.growth_artifacts (brand, artifact_type);

-- Office (admin | estimator) can read; only the service role writes (the i9
-- push uses the service key, which bypasses RLS). No client ever inserts here.
alter table public.growth_artifacts enable row level security;

drop policy if exists growth_artifacts_read on public.growth_artifacts;
create policy growth_artifacts_read on public.growth_artifacts for select using (is_office());
