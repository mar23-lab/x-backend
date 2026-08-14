// Customer-safe description of the runtime invariants enforced by the API request path.
// Workspace policy mutation is intentionally not exposed until it has durable storage,
// authorization, versioning, and audit receipts.

export interface RuntimePolicyGuarantee {
  id: string;
  label: string;
  summary: string;
  enforced: true;
}

export interface RuntimePolicyEnforcement {
  schema_id: 'xlooop.runtime_policy_enforcement.v1';
  status: 'enforced';
  authority: 'xlooop_backend';
  policy_version: 'commercial_live_v1';
  mutable: false;
  guarantees: RuntimePolicyGuarantee[];
}

const GUARANTEES: RuntimePolicyGuarantee[] = [
  {
    id: 'live_provider_only',
    label: 'Live providers only',
    summary: 'Conversational routes execute a live provider or return typed provider_unavailable.',
    enforced: true,
  },
  {
    id: 'tenant_scoped_resolution',
    label: 'Tenant-scoped runtime resolution',
    summary: 'Stored providers, defaults, and user overrides resolve inside the authenticated workspace.',
    enforced: true,
  },
  {
    id: 'request_preference_validation',
    label: 'Requested runtimes are validated',
    summary: 'A caller preference is accepted only when it resolves to an executable runtime allowed for this tenant.',
    enforced: true,
  },
  {
    id: 'private_runtime_relay',
    label: 'Private runtimes require a relay',
    summary: 'The cloud API never fetches arbitrary private-network model endpoints.',
    enforced: true,
  },
  {
    id: 'credential_non_disclosure',
    label: 'Credentials are write-only',
    summary: 'Provider credentials stay encrypted in the tenant vault and are never returned to clients.',
    enforced: true,
  },
  {
    id: 'execution_lineage',
    label: 'Execution lineage is recorded',
    summary: 'Commercial chat records provider, model, context, execution, policy, and audit references.',
    enforced: true,
  },
];

export function runtimePolicyEnforcement(): RuntimePolicyEnforcement {
  return {
    schema_id: 'xlooop.runtime_policy_enforcement.v1',
    status: 'enforced',
    authority: 'xlooop_backend',
    policy_version: 'commercial_live_v1',
    mutable: false,
    guarantees: GUARANTEES.map((guarantee) => ({ ...guarantee })),
  };
}
