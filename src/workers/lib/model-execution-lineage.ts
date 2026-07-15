import type { Sql } from '../db/client';
import {
  finishModelExecutionReceiptRow,
  startModelExecutionReceiptRow,
  type ModelExecutionFinishInput,
  type ModelExecutionProvider,
} from '../dal/model-execution-receipt-store';
import type { AssistantContextLineage } from './assistant-context-lineage';
import { envFlagTrue } from './env-flag';
import {
  completeAssistantSkillLineage,
  persistAssistantContextLineage,
  type AssistantContextLineageEnv,
  type AssistantContextLineageInput,
} from './assistant-context-lineage';

export interface ModelExecutionRun {
  complete(input: ModelExecutionFinishInput): Promise<void>;
}

export interface ModelExecutionObserver {
  start(input: { provider: ModelExecutionProvider; model_key: string }): Promise<ModelExecutionRun>;
}

export interface GovernedModelLineage {
  observer: ModelExecutionObserver;
  complete(): Promise<string[]>;
}

export type GovernedModelLineageFactory = (input: AssistantContextLineageInput) => Promise<GovernedModelLineage>;

export function createGovernedModelLineageFactory(
  sql: Sql,
  env: AssistantContextLineageEnv,
): GovernedModelLineageFactory {
  return async (input) => {
    const lineage = await persistAssistantContextLineage(sql, env, input);
    return {
      observer: createModelExecutionObserver(sql, input.workspace_id, input.principal_id, lineage),
      complete: () => completeAssistantSkillLineage(sql, env, lineage, {
        workspace_id: input.workspace_id,
        principal_id: input.principal_id,
      }),
    };
  };
}

export function modelLineagePolicy(
  sql: Sql | { load: () => Sql },
  env: AssistantContextLineageEnv & { CONTEXT_PACKET_PERSISTENCE_ENABLED?: string },
): { required: boolean; factory?: GovernedModelLineageFactory } {
  const required = envFlagTrue(env.CONTEXT_PACKET_PERSISTENCE_ENABLED);
  return {
    required,
    factory: required ? createGovernedModelLineageFactory('load' in sql ? sql.load() : sql, env) : undefined,
  };
}

export function createModelExecutionObserver(
  sql: Sql,
  workspaceId: string,
  principalId: string,
  lineage: AssistantContextLineage,
): ModelExecutionObserver {
  return {
    async start(input) {
      const receiptId = await startModelExecutionReceiptRow(sql, workspaceId, principalId, {
        resolution_id: lineage.resolution_id,
        context_packet_id: lineage.context_packet_id,
        action: lineage.action,
        provider: input.provider,
        model_key: input.model_key,
      });
      return {
        complete: (finish) => finishModelExecutionReceiptRow(sql, workspaceId, receiptId, finish),
      };
    },
  };
}
