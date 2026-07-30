// Action intent answers "what operation is requested?". It does not resolve role, skill, or authority.

export type ActionIntent = 'answer' | 'plan' | 'create_work' | 'continue_work' | 'decide' | 'inspect' | 'unresolved';

export interface ActionIntentClassification {
  action_intent: ActionIntent;
  confidence: number;
  matched_rule: string;
}

const RULES: Array<{ intent: Exclude<ActionIntent, 'unresolved'>; id: string; pattern: RegExp }> = [
  { intent: 'continue_work', id: 'continue', pattern: /\b(continue|resume|carry on|pick up|proceed with|finish|complete the remaining|next remaining)\b/i },
  { intent: 'decide', id: 'decide', pattern: /\b(decide|choose|select|approve|reject|go\/no-go|go or no-go|make the call|final call)\b/i },
  { intent: 'plan', id: 'plan', pattern: /\b(plan|roadmap|sequence|prioriti[sz]e|implementation steps|next steps|approach|strategy)\b/i },
  { intent: 'create_work', id: 'create', pattern: /\b(create|open|start|add|implement|build|fix|repair|write|generate|set up|setup)\b.*\b(task|packet|work item|issue|feature|route|test|migration|document|integration|workflow|report)?\b/i },
  { intent: 'inspect', id: 'inspect', pattern: /\b(inspect|audit|review|check|verify|validate|diagnose|status|show|list|find|trace|investigate|what happened)\b/i },
  { intent: 'answer', id: 'answer', pattern: /(^|\b)(what|why|how|when|where|who|explain|summari[sz]e|tell me|describe|do i|is there|are there)\b/i },
];

const EXPLICIT_READ_ONLY = /\bread[- ]only\s*(?=[:;,.!?\]]|$)|(?:\bdo\s+not\b|\bdon't\b|\bnever\b|\bwithout\b)\s+(?:\w+\s+){0,2}(?:creat(?:e|ing)|open(?:ing)?|start(?:ing)?|add(?:ing)?|implement(?:ing)?|build(?:ing)?|fix(?:ing)?|repair(?:ing)?|writ(?:e|ing)|generat(?:e|ing)|set(?:ting)?\s+up|approv(?:e|ing)|reject(?:ing)?|delet(?:e|ing)|edit(?:ing)?|modif(?:y|ying)|chang(?:e|ing))\b/i;
const READ_ONLY_INTENTS = new Set<ActionIntent>(['inspect', 'answer']);
const CONTINUE_CUES = /\b(continue|resume|carry on|pick up|proceed with|finish|complete the remaining|next remaining)\b/gi;
const DECISION_CUES = /\b(decide|choose|select|approve|reject|go\/no-go|go or no-go|make the call|final call)\b/gi;

function cueIsNegated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 180), index);
  const clause = before.split(/[.;:!?]/).at(-1) ?? before;
  const prohibition = clause.match(/\b(?:do\s+not|don't|never)\b([\s\S]*)$/i);
  if (prohibition) {
    const tail = prohibition[1] ?? '';
    if (!/\b(?:but|however|instead|then)\b/i.test(tail)) return true;
  }
  if (/\bwithout\b[^,]*$/i.test(clause)) return true;
  return /\bnot\s+(?:to\s+)?$/i.test(clause);
}

function hasAffirmativeCue(text: string, cues: RegExp): boolean {
  for (const cue of text.matchAll(cues)) {
    // A decision/continuation word inside an explicit negative guardrail describes what must not
    // happen. It is not the requested operation ("create this, but do not approve it").
    if (!cueIsNegated(text, cue.index ?? 0)) return true;
  }
  return false;
}

function hasAffirmativeWriteCue(text: string): boolean {
  const writeCues = text.matchAll(/\b(create|open|start|add|implement|build|fix|repair|write|generate|set up|setup)\b/gi);
  for (const cue of writeCues) {
    const before = text.slice(Math.max(0, (cue.index ?? 0) - 48), cue.index ?? 0);
    // A read request may name forbidden side effects ("do not create or change anything").
    // Those words are guardrails, not authority to create governed work.
    const directlyNegated = /\b(?:(?:do\s+not|don't|never)\s+(?:[a-z]+ly\s+){0,2}|without\s+(?:ever\s+)?|not\s+(?:to\s+)?)$/i.test(before);
    if (!directlyNegated) return true;
  }
  return false;
}

export function classifyActionIntent(raw: unknown): ActionIntentClassification {
  const text = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!text) return { action_intent: 'unresolved', confidence: 0, matched_rule: 'empty' };
  const explicitReadOnly = EXPLICIT_READ_ONLY.test(text);
  if (explicitReadOnly) {
    for (const rule of RULES) {
      if (READ_ONLY_INTENTS.has(rule.intent) && rule.pattern.test(text)) {
        return { action_intent: rule.intent, confidence: 0.98, matched_rule: rule.id };
      }
    }
    if (
      !hasAffirmativeCue(text, CONTINUE_CUES)
      && !hasAffirmativeCue(text, DECISION_CUES)
      && !hasAffirmativeWriteCue(text)
    ) {
      return { action_intent: 'inspect', confidence: 0.98, matched_rule: 'explicit_read_only' };
    }
  }
  for (const rule of RULES) {
    if (rule.intent === 'continue_work' && !hasAffirmativeCue(text, CONTINUE_CUES)) continue;
    if (rule.intent === 'decide' && !hasAffirmativeCue(text, DECISION_CUES)) continue;
    if (rule.intent === 'create_work' && !hasAffirmativeWriteCue(text)) continue;
    if (rule.pattern.test(text)) return { action_intent: rule.intent, confidence: 0.9, matched_rule: rule.id };
  }
  return { action_intent: 'unresolved', confidence: 0.25, matched_rule: 'no_rule' };
}
