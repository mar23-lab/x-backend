create table if not exists feedback_annotations (
  feedback_id text primary key,
  tenant_id text not null,
  environment text not null,
  user_email text not null,
  created_at text not null,
  updated_at text not null,
  status text not null default 'open',
  category text not null,
  severity text not null,
  comment text not null,
  route text,
  workspace_id text,
  domain_id text,
  domain_kind text,
  project_id text,
  lane_id text,
  board_id text,
  graph_path text not null,
  component_id text,
  control_id text,
  action_id text,
  target_label text,
  source_adapter text,
  data_provenance text,
  build_sha text,
  resolution_ref text,
  receipt_id text
);

create index if not exists idx_feedback_annotations_tenant_status
on feedback_annotations (tenant_id, status, created_at desc);

create index if not exists idx_feedback_annotations_graph_path
on feedback_annotations (graph_path);
