// prompt-refine.ts · W4 · "Improve wording" for a quick-prompt tag.
//
// Reuses the SAME never-throws-with-deterministic-fallback discipline as answerCockpitChat /
// buildWorkspaceDigestLLM: a missing/failing AI binding, a too-short/too-long input, or an unchanged
// rewrite ALL return the ORIGINAL text with refined=false — the operator can NEVER lose their prompt to
// this feature. SCOPE-AGNOSTIC by construction (the directive forbids inventing project/person/number
// detail), so a rewritten prompt is safe to reuse across every scope. Never throws.

import { type AiRunner } from './agent-digest';

/** Small instruct model (free-tier friendly) — same binding the cockpit chat + digest use. */
export const PROMPT_REFINE_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export interface PromptRefineResult {
  proposed: string;
  refined: boolean;
}

export async function refinePromptText(text: string, ai?: AiRunner): Promise<PromptRefineResult> {
  const original = String(text || '').trim();
  if (!original || original.length > 600) return { proposed: original, refined: false };
  if (!ai) return { proposed: original, refined: false };
  try {
    const out = await ai.run(PROMPT_REFINE_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You improve a short reusable "quick prompt" that an operator taps to ask their AI chief-of-staff about their work. '
            + 'Rewrite it to be clearer, more specific, and more actionable. Keep it SCOPE-AGNOSTIC — do NOT invent or reference any '
            + 'specific project, person, number, client, date, or status. Keep it under 200 characters, a single instruction, plain '
            + 'English, no markdown, no surrounding quotes. Return ONLY the rewritten prompt.',
        },
        { role: 'user', content: original },
      ],
      max_tokens: 120,
    });
    const proposed = String(
      (out && typeof out === 'object' && 'response' in (out as Record<string, unknown>)
        ? (out as { response?: unknown }).response
        : '') ?? '',
    ).trim().replace(/^["']+|["']+$/g, '').slice(0, 600);
    // Reject a no-op or a degenerate rewrite — degrade to the original (refined=false).
    if (proposed.length < 8 || proposed.toLowerCase() === original.toLowerCase()) {
      return { proposed: original, refined: false };
    }
    return { proposed, refined: true };
  } catch (_) {
    return { proposed: original, refined: false };
  }
}
