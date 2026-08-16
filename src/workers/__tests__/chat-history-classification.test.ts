import { describe, expect, it } from 'vitest';
import {
  classifyCommercialChatHistory,
  projectCommercialChatCitations,
} from '../services/chat-history-classification';

describe('commercial chat history citation projection', () => {
  const groundedOn = {
    workspace: { id: 'ws_1', name: 'Honest & Young' },
    plan: {
      project_id: 'proj_1',
      project_name: 'Capacity program',
      entities: [{ id: 'goal_1', title: 'Increase capacity', kind: 'goal' }],
    },
    event_ids: ['event_1'],
    documents: { names: ['operations-brief.pdf'] },
  };

  it('reconstructs the same customer-safe provenance after a persisted answer reload', () => {
    expect(projectCommercialChatCitations(groundedOn)).toEqual([
      { kind: 'workspace', ref: 'ws_1', label: 'Honest & Young' },
      { kind: 'project', ref: 'proj_1', label: 'Capacity program' },
      { kind: 'plan_entity', ref: 'goal_1', label: 'Increase capacity', entity_kind: 'goal' },
      { kind: 'event', ref: 'event_1' },
      { kind: 'document', label: 'operations-brief.pdf' },
    ]);
  });

  it('keeps live classification and citation count together in history responses', () => {
    const [message] = classifyCommercialChatHistory([{
      role: 'assistant',
      generated_by: 'llm',
      grounded_on: groundedOn,
    }]) as Array<Record<string, unknown>>;

    expect(message.activity_class).toBe('live_assistant_turn');
    expect(message.is_live_assistant).toBe(true);
    expect(message.citation_count).toBe(5);
    expect(message.citations).toEqual(projectCommercialChatCitations(groundedOn));
  });

  it('does not invent provenance for malformed or user history rows', () => {
    expect(projectCommercialChatCitations(null)).toEqual([]);
    const [message] = classifyCommercialChatHistory([{ role: 'you', grounded_on: groundedOn }]) as Array<Record<string, unknown>>;
    expect(message.citation_count).toBe(0);
    expect(message.citations).toEqual([]);
  });
});
