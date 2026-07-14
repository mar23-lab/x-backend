// connect-tasks-wave-c.test.ts · Wave C · S5a (260628).
// The customer declares WHERE their work lives (the integration multi-select) → each pick becomes
// an actionable "Connect <tool>" task on the day-1 roadmap. Proves the generator + that the base
// roadmap is unchanged (connect-tasks are appended, never woven into the byte-identical base).

import { describe, it, expect } from 'vitest';
import { buildConnectTasks, buildDay1Roadmap } from '../services/onboarding-roadmap';

describe('Wave C · S5a connect-tasks (where the work lives → roadmap to-dos)', () => {
  it('emits one "Connect <tool>" step per declared integration', () => {
    const steps = buildConnectTasks([{ id: 'slack', label: 'Slack' }, { id: 'jira', label: 'Jira' }]);
    expect(steps.map((s) => s.summary)).toEqual(['Connect Slack', 'Connect Jira']);
    expect(steps[0].body).toContain('Slack');
    expect(steps[0].body).toContain('Watch mode'); // read-only until Action authority — the safe posture
  });

  it('tolerates plain strings + de-duplicates (case-insensitive) + ignores junk', () => {
    const steps = buildConnectTasks(['Slack', { id: 'slack', label: 'Slack' }, { label: '' }, null, 'Notion']);
    expect(steps.map((s) => s.summary)).toEqual(['Connect Slack', 'Connect Notion']);
  });

  it('non-array / empty → no tasks (onboarding unchanged when nothing is declared)', () => {
    expect(buildConnectTasks(undefined)).toEqual([]);
    expect(buildConnectTasks([])).toEqual([]);
    expect(buildConnectTasks('slack')).toEqual([]);
  });

  it('buildDay1Roadmap stays byte-identical — connect-tasks are a separate append', () => {
    const base = buildDay1Roadmap({ level: 1, accountType: 'company' });
    expect(base.length).toBe(4); // 3 base + invite (company) — identical to pre-Wave-C
    expect(base.every((s) => !/^Connect (Slack|Jira|Notion|Salesforce|Xero)\b/.test(s.summary))).toBe(true);
  });
});
