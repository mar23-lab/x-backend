-- 098_model_execution_provider_superset.sql · STAGED ONLY, never auto-applied.
-- Widen model execution lineage from the original Anthropic/Workers-AI pair to the provider registry.
-- No prompts, outputs, credentials, or customer content are stored.

BEGIN;

DO $$
DECLARE cn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 98) THEN
    SELECT conname INTO cn
      FROM pg_constraint
     WHERE conrelid = 'model_execution_receipts'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%provider%'
     LIMIT 1;
    IF cn IS NOT NULL THEN
      EXECUTE format('ALTER TABLE model_execution_receipts DROP CONSTRAINT %I', cn);
    END IF;
    ALTER TABLE model_execution_receipts
      ADD CONSTRAINT model_execution_receipts_provider_check CHECK (provider IN (
        'anthropic','workers_ai','openai','google','mistral','deepseek','azure_openai','aws_bedrock',
        'openrouter','ollama','lm_studio','vllm','llama_cpp','custom'
      ));

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (98, 'model execution receipts accept the governed model-runtime provider registry', now());
  END IF;
END $$;

COMMIT;
