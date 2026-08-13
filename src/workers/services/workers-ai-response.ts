export interface WorkersAiTextResult {
  text: string;
  usage: { tokens_in: number | null; tokens_out: number | null };
}

export function normalizeWorkersAiText(out: Record<string, unknown>): WorkersAiTextResult {
  const usage = out.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const choices = Array.isArray(out.choices) ? out.choices : [];
  const firstChoice = choices[0] as { message?: { content?: unknown } } | undefined;
  const text = typeof out.response === 'string'
    ? out.response
    : typeof firstChoice?.message?.content === 'string'
      ? firstChoice.message.content
      : '';
  return {
    text: text.trim(),
    usage: { tokens_in: usage?.prompt_tokens ?? null, tokens_out: usage?.completion_tokens ?? null },
  };
}
