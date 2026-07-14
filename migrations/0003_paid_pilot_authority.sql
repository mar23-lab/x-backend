create table if not exists paid_pilot_identities (
  identity_id text primary key,
  email text not null unique,
  display_name text,
  principal_kind text not null,
  status text not null default 'active',
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create index if not exists idx_paid_pilot_identities_email_status
on paid_pilot_identities (lower(email), status);

create table if not exists paid_pilot_tenant_memberships (
  membership_id text primary key,
  identity_id text not null,
  tenant_id text not null,
  owner_graph_id text not null,
  workspace_id text not null,
  roles_json text not null default '[]',
  permissions_json text not null default '[]',
  telemetry_scopes_json text not null default '[]',
  status text not null default 'active',
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  unique(identity_id, tenant_id, workspace_id)
);

create index if not exists idx_paid_pilot_memberships_identity
on paid_pilot_tenant_memberships (identity_id, status);

create table if not exists paid_pilot_app_entitlements (
  entitlement_id text primary key,
  identity_id text not null,
  app_id text not null,
  status text not null default 'disabled',
  enabled_by text,
  authority_ref text,
  risk_lane text not null default 'paid_pilot',
  expires_at text,
  review_due text,
  allowed_modes_json text not null default '[]',
  allowed_actions_json text not null default '[]',
  denied_actions_json text not null default '[]',
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  unique(identity_id, app_id)
);

create index if not exists idx_paid_pilot_entitlements_identity_app
on paid_pilot_app_entitlements (identity_id, app_id, status);

create table if not exists paid_pilot_role_permissions (
  permission_id text primary key,
  role_id text not null,
  permission text not null,
  status text not null default 'active',
  created_at text not null default (datetime('now')),
  unique(role_id, permission)
);

create table if not exists paid_pilot_action_policies (
  action_type text primary key,
  status text not null default 'disabled',
  required_mode text not null default 'operator',
  required_permission text not null,
  approval_required integer not null default 1,
  receipt_policy text not null,
  source_kind text,
  path_allowlist_json text not null default '[]',
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create table if not exists paid_pilot_actions (
  action_id text primary key,
  tenant_id text not null,
  identity_id text not null,
  actor_id text not null,
  action_type text not null,
  target_ref text,
  graph_path text,
  requested_mode text not null,
  policy_decision text not null,
  status text not null,
  idempotency_key text,
  proposal_id text,
  approval_id text,
  receipt_id text,
  verifier_ref text,
  rollback_ref text,
  request_json text not null default '{}',
  response_json text not null default '{}',
  created_at text not null,
  updated_at text not null,
  unique(tenant_id, action_type, idempotency_key)
);

create index if not exists idx_paid_pilot_actions_tenant_created
on paid_pilot_actions (tenant_id, created_at desc);

create index if not exists idx_paid_pilot_actions_status
on paid_pilot_actions (status, updated_at desc);

create table if not exists paid_pilot_source_writeback_receipts (
  receipt_id text primary key,
  action_id text not null,
  tenant_id text not null,
  identity_id text not null,
  source_repo text not null,
  source_path text not null,
  source_kind text not null,
  before_hash text,
  after_hash text,
  patch_hash text,
  approval_ref text not null,
  commit_ref text,
  verifier_ref text not null,
  rollback_ref text not null,
  collaboration_claim_id text not null,
  status text not null,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_paid_pilot_writeback_action
on paid_pilot_source_writeback_receipts (action_id, status);

create table if not exists paid_pilot_audit_events (
  event_id text primary key,
  event_type text not null,
  tenant_id text not null,
  identity_id text,
  action_id text,
  created_at text not null,
  severity text not null,
  detail_json text not null default '{}'
);

create index if not exists idx_paid_pilot_audit_events_type_created
on paid_pilot_audit_events (event_type, created_at desc);
