create table if not exists customer_feedback_tenant_memberships (
  membership_id text primary key,
  email text not null,
  tenant_id text not null,
  owner_graph_id text not null,
  workspace_id text not null,
  roles_json text not null default '[]',
  permissions_json text not null default '[]',
  status text not null default 'active',
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create index if not exists idx_customer_feedback_memberships_email
on customer_feedback_tenant_memberships (lower(email), status);

create table if not exists customer_feedback_app_entitlements (
  entitlement_id text primary key,
  email text not null,
  app_id text not null,
  status text not null default 'disabled',
  enabled_by text,
  authority_ref text,
  risk_lane text not null default 'customer_feedback',
  expires_at text,
  review_due text,
  allowed_modes_json text not null default '[]',
  allowed_actions_json text not null default '[]',
  denied_actions_json text not null default '[]',
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  unique(email, app_id)
);

create index if not exists idx_customer_feedback_entitlements_email_app
on customer_feedback_app_entitlements (lower(email), app_id, status);

create table if not exists customer_feedback_proposals (
  proposal_id text primary key,
  tenant_id text not null,
  identity_id text not null,
  actor_id text not null,
  created_at text not null,
  status text not null,
  mode text not null,
  action_id text not null,
  target_ref text,
  graph_path text,
  reason text,
  expected_receipt_policy text not null
);

create index if not exists idx_customer_feedback_proposals_tenant_created
on customer_feedback_proposals (tenant_id, created_at desc);

create table if not exists customer_feedback_receipts (
  receipt_id text primary key,
  tenant_id text not null,
  identity_id text not null,
  actor_id text not null,
  created_at text not null,
  status text not null,
  mode text not null,
  action_id text not null,
  target_ref text,
  graph_path text,
  rollback_ref text,
  verifier_ref text
);

create index if not exists idx_customer_feedback_receipts_tenant_created
on customer_feedback_receipts (tenant_id, created_at desc);

create table if not exists customer_feedback_monitoring_events (
  event_id text primary key,
  event_type text not null,
  tenant_id text not null,
  created_at text not null,
  severity text not null,
  detail_json text not null default '{}'
);

create index if not exists idx_customer_feedback_monitoring_events_type_created
on customer_feedback_monitoring_events (event_type, created_at desc);
