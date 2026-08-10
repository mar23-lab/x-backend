import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const POSTURE_FLAGS = {
  single_intake: 'SINGLE_INTAKE_ENABLED',
  role_skill_catalog: 'ROLE_SKILL_CATALOG_ENABLED',
  context_packet_persistence: 'CONTEXT_PACKET_PERSISTENCE_ENABLED',
  chat_history_persistence_required: 'CHAT_HISTORY_PERSISTENCE_REQUIRED',
  tenant_projection_queue: 'TENANT_PROJECTION_QUEUE_ENABLED',
  current_work_projection: 'CURRENT_WORK_PROJECTION_ENABLED',
};

const DEPLOYMENT_CONFIGS = Object.freeze({
  'wrangler.toml': Object.freeze({
    environment: 'production',
    authority: 'production',
    api_base: 'https://api.xlooop.com',
  }),
  'wrangler.pilot-shadow.toml': Object.freeze({
    environment: 'pilot-shadow',
    authority: 'shadow',
    api_base: 'https://xlooop-api-pilot-shadow.xlooop23.workers.dev',
  }),
});

function tomlStringVar(source, name, required = false) {
  const match = source.match(new RegExp(`^${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*(?:#.*)?$`, 'm'));
  if (!match) {
    if (required) throw new Error(`wrangler.toml is missing ${name}`);
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new Error(`wrangler.toml ${name} is not a JSON-safe TOML string`);
  }
}

export function localMigrationHead(root) {
  const versions = readdirSync(path.join(root, 'src', 'workers', 'db', 'migrations'))
    .map((name) => Number(name.match(/^(\d+)_/)?.[1]))
    .filter(Number.isSafeInteger);
  if (versions.length === 0) throw new Error('no numbered database migrations found');
  return Math.max(...versions);
}

export function readCandidateDeploymentContract(root, env = process.env) {
  const contract = JSON.parse(readFileSync(
    path.join(root, 'docs', 'contracts', 'api-contract.v1.json'),
    'utf8',
  ));
  if (!/^[0-9a-f]{64}$/.test(contract.contract_hash || '')) {
    throw new Error('candidate API contract hash is invalid');
  }
  const schemaHead = Number(env.XLOOOP_SCHEMA_HEAD);
  const migrationHead = localMigrationHead(root);
  if (!Number.isSafeInteger(schemaHead) || schemaHead < 1) {
    throw new Error('XLOOOP_SCHEMA_HEAD must be a positive integer');
  }
  if (schemaHead !== migrationHead) {
    throw new Error(`XLOOOP_SCHEMA_HEAD ${schemaHead} does not match candidate migration head ${migrationHead}`);
  }
  const configName = String(env.XLOOOP_DEPLOYMENT_WRANGLER_CONFIG || 'wrangler.toml').trim();
  const expected = DEPLOYMENT_CONFIGS[configName];
  if (!expected) {
    throw new Error(`XLOOOP_DEPLOYMENT_WRANGLER_CONFIG is not allowlisted: ${configName}`);
  }
  const wrangler = readFileSync(path.join(root, configName), 'utf8');
  const environment = tomlStringVar(wrangler, 'ENVIRONMENT', true);
  const authority = tomlStringVar(wrangler, 'XLOOOP_AUTHORITY_MODE', true);
  if (environment !== expected.environment) {
    throw new Error(`candidate ENVIRONMENT must be ${expected.environment}, got ${environment}`);
  }
  if (authority !== expected.authority) {
    throw new Error(`candidate authority must be ${expected.authority}, got ${authority}`);
  }
  return {
    worker_name: tomlStringVar(wrangler, 'name', true),
    wrangler_config: configName,
    contract_hash: contract.contract_hash,
    schema_head: schemaHead,
    environment,
    authority,
    api_base: expected.api_base,
    feature_posture: Object.fromEntries(
      Object.entries(POSTURE_FLAGS).map(([key, flag]) => [
        key,
        /^(1|true|yes|on)$/i.test(String(tomlStringVar(wrangler, flag) ?? '')),
      ]),
    ),
  };
}
