#!/usr/bin/env node
import fs from 'node:fs';

const corpus = JSON.parse(fs.readFileSync('src/workers/__fixtures__/action-intent-corpus.json', 'utf8'));
const route = fs.readFileSync('src/workers/routes/action-intent-shadow.ts', 'utf8');
const kernel = fs.readFileSync('src/workers/lib/action-intent.ts', 'utf8');
const { classifyActionIntent } = await import('../src/workers/lib/action-intent.ts');
const labels = ['answer', 'plan', 'create_work', 'continue_work', 'decide', 'inspect'];
const count = labels.reduce((sum, label) => sum + (Array.isArray(corpus[label]) ? corpus[label].length : 0), 0);
const failures = [];
if (count < 100) failures.push(`labelled corpus too small: ${count} < 100`);
for (const label of labels) if (!kernel.includes(`'${label}'`) || !Array.isArray(corpus[label])) failures.push(`missing label ${label}`);
if (!kernel.includes("'unresolved'")) failures.push('classifier lacks fail-closed unresolved state');
if (!route.includes('ACTION_INTENT_SHADOW_ENABLED')) failures.push('route is not default-off behind shadow flag');
if (!route.includes("authority: 'advisory_shadow_only'")) failures.push('route does not label non-authority');
if (/role_key|selected_skills|entry_skill/.test(kernel)) failures.push('action classifier improperly performs role/skill resolution');
let correct = 0;
for (const label of labels) {
  const prompts = corpus[label] ?? [];
  const labelCorrect = prompts.filter((prompt) => classifyActionIntent(prompt).action_intent === label).length;
  correct += labelCorrect;
  if (labelCorrect / prompts.length < 0.9) failures.push(`${label} recall below 90%: ${labelCorrect}/${prompts.length}`);
}
const accuracy = correct / count;
if (accuracy < 0.95) failures.push(`overall accuracy below 95%: ${(accuracy * 100).toFixed(2)}%`);
if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL ${failure}`));
  process.exit(1);
}
console.log(`PASS action-intent shadow: ${count} labelled prompts, ${(accuracy * 100).toFixed(2)}% accuracy, >=90% per-class recall, unresolved fail-closed, default-off, no role/skill authority`);
