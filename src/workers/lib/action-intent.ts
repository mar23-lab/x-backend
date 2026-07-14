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

export function classifyActionIntent(raw: unknown): ActionIntentClassification {
  const text = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!text) return { action_intent: 'unresolved', confidence: 0, matched_rule: 'empty' };
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { action_intent: rule.intent, confidence: 0.9, matched_rule: rule.id };
  }
  return { action_intent: 'unresolved', confidence: 0.25, matched_rule: 'no_rule' };
}
