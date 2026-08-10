import { describe, expect, it } from 'vitest';
import migration from '../db/migrations/098_model_execution_provider_superset.sql?raw';

describe('migration 098 model execution provider superset', () => {
  it('widens the existing receipt constraint without creating a competing receipt table', () => {
    expect(migration).toContain('ALTER TABLE model_execution_receipts');
    expect(migration).toContain('model_execution_receipts_provider_check');
    expect(migration).not.toMatch(/CREATE TABLE\s+model_execution_receipts/i);
  });

  it('keeps the receipt provider set aligned with the governed model-runtime registry', () => {
    for (const provider of [
      'anthropic', 'workers_ai', 'openai', 'google', 'mistral', 'deepseek', 'azure_openai',
      'aws_bedrock', 'openrouter', 'ollama', 'lm_studio', 'vllm', 'llama_cpp', 'custom',
    ]) {
      expect(migration).toContain(`'${provider}'`);
    }
  });

  it('records schema version 98 exactly once and stores no customer content columns', () => {
    expect(migration).toContain('WHERE version = 98');
    expect(migration).toMatch(/VALUES\s*\(98, 'model execution receipts accept/);
    expect(migration).not.toMatch(/prompt_text|response_body|customer_content/i);
  });
});
