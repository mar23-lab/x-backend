import { describe, expect, it, vi } from 'vitest';
import {
  ExternalCapabilityUnavailableError,
  compressPromptWithHeadroom,
  convertDocumentWithMarkitdown,
  hashText,
  headroomEnabled,
  markitdownEnabled,
} from '../services/external-capability-adapter';

function binding(handler: (body: Record<string, any>, request: Request) => unknown): Fetcher {
  return {
    fetch: vi.fn(async (request: Request) => {
      const body = await request.json() as Record<string, any>;
      return Response.json(await handler(body, request));
    }),
    connect: vi.fn(),
  } as unknown as Fetcher;
}

describe('external capability service-binding client', () => {
  it('requires both a tenant flag and the private binding', () => {
    expect(markitdownEnabled({ MARKITDOWN_ADAPTER_ENABLED: 'true' })).toBe(false);
    expect(headroomEnabled({ HEADROOM_COMPRESSION_ENABLED: 'false', EXTERNAL_CAPABILITY_ADAPTER: binding(() => ({})) })).toBe(false);
  });

  it('converts through the private contract without exposing the raw workspace id', async () => {
    let observed: Record<string, any> = {};
    const env = {
      MARKITDOWN_ADAPTER_ENABLED: 'true',
      EXTERNAL_CAPABILITY_ADAPTER: binding(async (body, request) => {
        observed = body;
        expect(request.headers.get('x-xlooop-capability-contract')).toBe('xlooop.external-capability-adapter.v1');
        const extractedText = 'converted';
        return {
          extracted_text: extractedText,
          source_spans: [{ start: 0, end: 9, source_ref: 'sha256:source' }],
          receipt: {
            capability: 'markitdown', tool_version: '0.1.7', source_hash: 'source',
            output_hash: await hashText(extractedText), latency_ms: 5, replayable: true,
          },
        };
      }),
    };
    const result = await convertDocumentWithMarkitdown({
      env, workspace_id: 'private-workspace-id', request_id: 'req-1', filename: 'brief.docx',
      content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content_base64: 'ZGF0YQ==', source_hash: 'source',
    });
    expect(result.extracted_text).toBe('converted');
    expect(JSON.stringify(observed)).not.toContain('private-workspace-id');
    expect(observed.tenant_ref).toMatch(/^[a-f0-9]{32}$/);
  });

  it('rejects a conversion receipt that cannot replay the requested source', async () => {
    const env = {
      MARKITDOWN_ADAPTER_ENABLED: 'true',
      EXTERNAL_CAPABILITY_ADAPTER: binding(async () => ({
        extracted_text: 'converted', source_spans: [],
        receipt: { capability: 'markitdown', source_hash: 'wrong', output_hash: await hashText('converted'), replayable: true },
      })),
    };
    await expect(convertDocumentWithMarkitdown({
      env, workspace_id: 'ws', request_id: null, filename: 'a.docx', content_type: 'x',
      content_base64: 'ZGF0YQ==', source_hash: 'expected',
    })).rejects.toBeInstanceOf(ExternalCapabilityUnavailableError);
  });

  it('redacts obvious secrets before Headroom and validates original-payload hashes', async () => {
    let sourceMessages: Array<{ role: string; content: string }> = [];
    const env = {
      HEADROOM_COMPRESSION_ENABLED: 'true',
      EXTERNAL_CAPABILITY_ADAPTER: binding(async (body) => {
        sourceMessages = body.messages;
        const compressed = [sourceMessages[0], { role: 'user', content: 'compressed user context' }];
        return {
          system: sourceMessages[0].content,
          user: 'compressed user context',
          receipt: {
            capability: 'headroom', tool_version: '0.34.0', source_hash: body.source_hash,
            output_hash: await hashText(JSON.stringify(compressed)), latency_ms: 9, replayable: true,
            tokens_before: 100, tokens_after: 40, token_reduction_pct: 60,
            transforms_applied: ['deduplicate'], redaction_count: body.redaction_count,
          },
        };
      }),
    };
    const result = await compressPromptWithHeadroom({
      env, workspace_id: 'ws', request_id: 'req', system: 'Keep policy',
      user: 'Use api_key=sk-test-SECRET123456 but do not expose it',
    });
    expect(JSON.stringify(sourceMessages)).not.toContain('sk-test-SECRET123456');
    expect(result.receipt.redaction_count).toBeGreaterThan(0);
    expect(result.receipt.token_reduction_pct).toBe(60);
  });

  it('rejects compression below the per-request reduction gate', async () => {
    const env = {
      HEADROOM_COMPRESSION_ENABLED: 'true',
      EXTERNAL_CAPABILITY_ADAPTER: binding(async (body) => ({
        system: body.messages[0].content,
        user: body.messages[1].content,
        receipt: {
          capability: 'headroom', tool_version: '0.34.0', source_hash: body.source_hash,
          output_hash: await hashText(JSON.stringify(body.messages)), latency_ms: 2, replayable: true,
          tokens_before: 100, tokens_after: 90, token_reduction_pct: 10,
          transforms_applied: [], redaction_count: 0,
        },
      })),
    };
    await expect(compressPromptWithHeadroom({
      env, workspace_id: 'ws', request_id: null, system: 'policy', user: 'question',
    })).rejects.toBeInstanceOf(ExternalCapabilityUnavailableError);
  });

  it('rejects compression that changes the governed system policy', async () => {
    const env = {
      HEADROOM_COMPRESSION_ENABLED: 'true',
      EXTERNAL_CAPABILITY_ADAPTER: binding(async (body) => {
        const compressed = [
          { role: 'system', content: 'weakened policy' },
          { role: 'user', content: body.messages[1].content },
        ];
        return {
          system: compressed[0].content,
          user: compressed[1].content,
          receipt: {
            capability: 'headroom', tool_version: '0.34.0', source_hash: body.source_hash,
            output_hash: await hashText(JSON.stringify(compressed)), latency_ms: 2, replayable: true,
            tokens_before: 100, tokens_after: 40, token_reduction_pct: 60,
            transforms_applied: ['unsafe-system-change'], redaction_count: 0,
          },
        };
      }),
    };
    await expect(compressPromptWithHeadroom({
      env, workspace_id: 'ws', request_id: null, system: 'Keep tenant policy', user: 'question',
    })).rejects.toBeInstanceOf(ExternalCapabilityUnavailableError);
  });

  it('rejects compression that drops protected customer facts or the operator question', async () => {
    const env = {
      HEADROOM_COMPRESSION_ENABLED: 'true',
      EXTERNAL_CAPABILITY_ADAPTER: binding(async (body) => {
        const compressed = [body.messages[0], { role: 'user', content: 'short context without identifiers' }];
        return {
          system: compressed[0].content,
          user: compressed[1].content,
          receipt: {
            capability: 'headroom', tool_version: '0.34.0', source_hash: body.source_hash,
            output_hash: await hashText(JSON.stringify(compressed)), latency_ms: 2, replayable: true,
            tokens_before: 100, tokens_after: 30, token_reduction_pct: 70,
            transforms_applied: ['unsafe-fact-drop'], redaction_count: 0,
          },
        };
      }),
    };
    await expect(compressPromptWithHeadroom({
      env,
      workspace_id: 'ws',
      request_id: null,
      system: 'Keep tenant policy',
      user: 'Event "Approve launch" in proj_123. Citation source:packet-7:line-2.\nOperator question: Can we approve it?',
    })).rejects.toBeInstanceOf(ExternalCapabilityUnavailableError);
  });
});
