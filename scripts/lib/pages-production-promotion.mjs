import { execFileSync } from 'node:child_process';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX40 = /^[0-9a-f]{40}$/;

export function deploymentShortId(output) {
  const match = String(output || '').match(/https:\/\/([0-9a-f]{8})\.[a-z0-9-]+\.pages\.dev/i);
  return match ? match[1].toLowerCase() : null;
}

export function assessProductionDeployment(deployment, expectedFrontendSha, expectedShortId = null) {
  const problems = [];
  const sha = String(expectedFrontendSha || '').toLowerCase();
  if (!deployment || typeof deployment !== 'object') return ['deployment_missing'];
  if (!UUID.test(String(deployment.id || ''))) problems.push('deployment_id');
  if (deployment.environment !== 'production') problems.push('deployment_environment');
  if (deployment.latest_stage?.status !== 'success') problems.push('deployment_status');
  if (!HEX40.test(sha) || deployment.deployment_trigger?.metadata?.commit_hash !== sha) {
    problems.push('deployment_frontend_sha');
  }
  if (expectedShortId && String(deployment.short_id || '').toLowerCase() !== expectedShortId) {
    problems.push('deployment_short_id');
  }
  return problems;
}

export function canonicalDeploymentMatches(project, candidate) {
  const canonical = project?.canonical_deployment;
  return Boolean(canonical?.id
    && candidate?.id
    && canonical.id === candidate.id
    && canonical.deployment_trigger?.metadata?.commit_hash
      === candidate.deployment_trigger?.metadata?.commit_hash);
}

function wranglerToken(root) {
  const raw = execFileSync(process.execPath, [
    path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    'auth', 'token', '--json',
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const parsed = JSON.parse(raw);
  const token = parsed?.token || parsed?.api_token || parsed?.credentials?.token;
  if (!token) throw new Error('Wrangler authentication token is unavailable for Pages promotion');
  return token;
}

async function cloudflareJson(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) {
    throw new Error(`Cloudflare Pages API ${response.status}: ${JSON.stringify(body?.errors || body)}`);
  }
  return body.result;
}

export async function promoteExactPagesDeployment({
  root,
  deploymentOutput,
  expectedFrontendSha,
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '725b9700a78047bee164431a5a432d13',
  projectName = 'xlooop-app',
  timeoutSeconds = 90,
}) {
  const shortId = deploymentShortId(deploymentOutput);
  if (!shortId) throw new Error('Wrangler output did not expose the uploaded Pages deployment URL');
  const token = wranglerToken(root);
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`;
  const deployments = await cloudflareJson(`${base}/deployments?env=production&per_page=25`, token);
  const candidate = deployments.find((entry) => String(entry.short_id || '').toLowerCase() === shortId);
  const problems = assessProductionDeployment(candidate, expectedFrontendSha, shortId);
  if (problems.length) throw new Error(`uploaded Pages deployment is not promotable: ${problems.join(',')}`);

  let project = await cloudflareJson(base, token);
  if (!canonicalDeploymentMatches(project, candidate)) {
    await cloudflareJson(`${base}/deployments/${candidate.id}/rollback`, token, { method: 'POST' });
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  do {
    project = await cloudflareJson(base, token);
    if (canonicalDeploymentMatches(project, candidate)) {
      return { deployment_id: candidate.id, short_id: shortId, canonical: true };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } while (true);
  throw new Error(`Pages canonical deployment did not become ${candidate.id} within ${timeoutSeconds}s`);
}
