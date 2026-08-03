import { describe, expect, it } from 'vitest';
import { scrubSensitiveText } from '../sentry';

// These are the two leaks MEASURED on 2026-08-03. Key-based redaction could not catch either,
// because both live at event.exception.values[].value — key `value`, which matches nothing in
// REDACT_FIELD_RE. The assertions below are written against the real message shapes, not invented
// ones, so they keep protecting the actual failure and not a paraphrase of it.

describe('scrubSensitiveText · exception MESSAGES, not just structured keys', () => {
  it('removes credentials from a Postgres DSN in a connection-error message', () => {
    const raw = 'Error connecting to postgres://neondb_owner:npg_S3cr3tPw@ep-x.neon.tech/neondb';
    const out = scrubSensitiveText(raw);
    expect(out).not.toContain('npg_S3cr3tPw');
    expect(out).not.toContain('neondb_owner:');
    expect(out).toContain('postgres://[REDACTED]@');
    // Still diagnostic: the host must survive or the scrub has destroyed the bug report.
    expect(out).toContain('ep-x.neon.tech');
  });

  it('removes the offending VALUES from a Postgres unique-violation message', () => {
    const raw = 'duplicate key value violates unique constraint "members_email_key" '
      + 'Key (email)=(alice@customer.example) already exists.';
    const out = scrubSensitiveText(raw);
    expect(out).not.toContain('alice@customer.example');
    expect(out).toContain('Key ([REDACTED])=([REDACTED])');
    // The constraint name is the diagnostic part and must be preserved.
    expect(out).toContain('members_email_key');
  });

  it('removes Bearer tokens and bare JWTs', () => {
    expect(scrubSensitiveText('failed with Authorization: Bearer abc123.def456-ghi'))
      .not.toContain('abc123.def456-ghi');
    expect(scrubSensitiveText('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'))
      .toContain('[REDACTED_JWT]');
  });

  it('covers every URI scheme with embedded credentials, not just postgres', () => {
    for (const scheme of ['postgresql', 'redis', 'https', 'amqp']) {
      const out = scrubSensitiveText(`connect ${scheme}://user:pw@host/path`);
      expect(out).not.toContain('user:pw');
      expect(out).toContain(`${scheme}://[REDACTED]@`);
    }
  });

  it('leaves ordinary diagnostic text untouched', () => {
    // Over-redaction destroys the bug report, so the negative control matters as much as the rest.
    const benign = 'TypeError: cannot read property id of undefined at listDocumentsRow (dal:171)';
    expect(scrubSensitiveText(benign)).toBe(benign);
    expect(scrubSensitiveText('workspace_id=org_3EG82VEzc8t3t65XSZ0YDlcaDMI'))
      .toBe('workspace_id=org_3EG82VEzc8t3t65XSZ0YDlcaDMI');
  });
});
