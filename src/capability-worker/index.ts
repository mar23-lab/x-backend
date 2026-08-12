import { ContainerProxy, Sandbox, getSandbox, type Sandbox as SandboxType } from '@cloudflare/sandbox';

export { ContainerProxy };

const CONTRACT = 'xlooop.external-capability-adapter.v1';
const MAX_REQUEST_BYTES = 7 * 1024 * 1024;

export class CapabilitySandbox extends Sandbox {
  enableInternet = false;
}

interface Env {
  CapabilitySandbox: DurableObjectNamespace<SandboxType>;
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: message, code }, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST') return jsonError(405, 'METHOD_NOT_ALLOWED', 'POST required');
    if (!['/v1/convert/markitdown', '/v1/compress/headroom'].includes(url.pathname)) {
      return jsonError(404, 'NOT_FOUND', 'unknown capability operation');
    }
    if (request.headers.get('x-xlooop-capability-contract') !== CONTRACT) {
      return jsonError(403, 'CONTRACT_REQUIRED', 'private capability contract required');
    }
    const declaredLength = Number(request.headers.get('content-length') || '0');
    if (declaredLength > MAX_REQUEST_BYTES) return jsonError(413, 'TOO_LARGE', 'request exceeds adapter limit');
    const body = await request.text();
    if (!body || new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
      return jsonError(413, 'TOO_LARGE', 'request exceeds adapter limit');
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return jsonError(400, 'INVALID_JSON', 'valid JSON object required');
    }
    if (!payload || Array.isArray(payload) || payload.schema_id !== CONTRACT) {
      return jsonError(400, 'INVALID_CONTRACT', 'capability payload contract mismatch');
    }
    const operation = url.pathname === '/v1/convert/markitdown' ? 'markitdown.convert' : 'headroom.compress';

    const sandboxId = `cap-${crypto.randomUUID()}`;
    const sandbox = getSandbox(env.CapabilitySandbox, sandboxId, {
      enableDefaultSession: false,
      sleepAfter: '1m',
      labels: { workload: 'xlooop-external-capability' },
    });
    try {
      await sandbox.writeFile('/workspace/request.json', JSON.stringify({ ...payload, operation }));
      const result = await sandbox.exec(
        'env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp MARKITDOWN_ENABLE_PLUGINS=0 '
        + 'TIKTOKEN_CACHE_DIR=/opt/xlooop/tiktoken-cache '
        + 'HEADROOM_CONFIG_DIR=/tmp/headroom-config HEADROOM_WORKSPACE_DIR=/tmp/headroom-workspace '
        + 'python3 /opt/xlooop/external-capability-runner.py /workspace/request.json /workspace/response.json',
        { timeout: 15_000 },
      );
      if (!result.success) {
        console.log(JSON.stringify({ kind: 'capability_adapter_failed', exit_code: result.exitCode }));
        return jsonError(503, 'CAPABILITY_EXECUTION_FAILED', 'sandboxed capability execution failed');
      }
      const output = await sandbox.readFile('/workspace/response.json');
      return new Response(output.content, {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    } catch (error) {
      console.log(JSON.stringify({
        kind: 'capability_adapter_unavailable',
        error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      }));
      return jsonError(503, 'CAPABILITY_ADAPTER_UNAVAILABLE', 'sandboxed capability adapter unavailable');
    } finally {
      await sandbox.destroy().catch(() => undefined);
    }
  },
};
