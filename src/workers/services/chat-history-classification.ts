export type CommercialChatHistoryClass =
  | 'user_input'
  | 'live_assistant_turn'
  | 'legacy_non_live_projection';

/** Preserve legacy rows for audit while preventing them from masquerading as current live AI. */
export function classifyCommercialChatHistory(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    const row = message as Record<string, unknown>;
    const assistant = row.role === 'assistant';
    const live = assistant && row.generated_by === 'llm';
    const activityClass: CommercialChatHistoryClass = assistant
      ? live ? 'live_assistant_turn' : 'legacy_non_live_projection'
      : 'user_input';
    return {
      ...row,
      activity_class: activityClass,
      is_live_assistant: live,
      commercial_render_policy: activityClass === 'legacy_non_live_projection'
        ? 'historical_projection_only'
        : 'standard',
    };
  });
}
