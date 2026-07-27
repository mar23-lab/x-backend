#!/usr/bin/env node

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const JSON_OUT = argv.includes('--json');

const TABLES = ['intake_resolutions', 'governed_execution_receipts', 'chat_messages'];
const COLUMNS = {
  intake_resolutions: {
    interaction_id: 'text',
  },
  governed_execution_receipts: {
    interaction_id: 'text',
    intent_id: 'text',
    operation_event_id: 'text',
    audit_event_id: 'text',
    projection_outbox_id: 'text',
    conversation_message_id: 'bigint',
  },
  chat_messages: {
    interaction_id: 'text',
    entry_type: 'text',
    resolution_id: 'text',
    execution_receipt_id: 'text',
    packet_id: 'text',
    operation_event_id: 'text',
    intent_id: 'text',
    audit_event_id: 'text',
    closing_attestation_id: 'text',
  },
};
const ENTRY_TYPES = [
  'assistant_answer',
  'execution_outcome',
  'resolution_preview',
  'system_failure',
  'user_request',
];
const INDEXES = {
  chat_messages_interaction_entry_key: {
    unique: true,
    fragments: [
      '(thread_id, interaction_id, entry_type)',
      'interaction_id is not null',
      'entry_type is not null',
    ],
  },
  chat_messages_execution_receipt: {
    unique: false,
    fragments: ['(execution_receipt_id)', 'execution_receipt_id is not null'],
  },
  chat_messages_resolution: {
    unique: false,
    fragments: ['(resolution_id)', 'resolution_id is not null'],
  },
  intake_resolutions_interaction: {
    unique: false,
    fragments: ['(workspace_id, actor_user_id, interaction_id)', 'interaction_id is not null'],
  },
  governed_execution_receipts_interaction: {
    unique: true,
    fragments: [
      '(workspace_id, actor_user_id, interaction_id)',
      'interaction_id is not null',
    ],
  },
};

function failure(failures, id, actual, expected) {
  failures.push({ id, actual, expected });
}

function normalizeSql(value) {
  return String(value || '')
    .toLowerCase()
    .replaceAll('"', '')
    .replace(/::[a-z_ ]+/g, '')
    .replace(/[()]/g, (match) => match)
    .replace(/\s+/g, ' ')
    .trim();
}

function quotedValues(definition) {
  return [...String(definition || '').matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    .sort();
}

function expectedColumnRows() {
  return Object.entries(COLUMNS).flatMap(([table, columns]) => (
    Object.entries(columns).map(([column, dataType]) => ({
      table_name: table,
      column_name: column,
      data_type: dataType,
      is_nullable: 'YES',
    }))
  ));
}

export function classifyMigration091Preflight(snapshot) {
  const failures = [];
  const maxVersion = Number(snapshot.max_version);
  const version90Rows = Number(snapshot.version_90_rows);
  const version91Rows = Number(snapshot.version_91_rows);
  const blockingLockCount = Number(snapshot.blocking_lock_count);
  const expectedColumns = expectedColumnRows();
  const columns = snapshot.columns || [];
  const indexes = snapshot.indexes || [];
  const constraints = snapshot.constraints || [];
  const tableOwners = snapshot.table_owners || [];
  const alreadyApplied = version91Rows === 1 || maxVersion === 91;

  for (const table of TABLES) {
    if (!snapshot.table_exists?.[table]) {
      failure(failures, `table_exists:${table}`, false, true);
    }
    const owner = tableOwners.find((row) => row.table_name === table);
    if (!owner?.migration_role_can_alter) {
      failure(failures, `migration_role_can_alter:${table}`, false, true);
    }
  }
  if (blockingLockCount !== 0) {
    failure(failures, 'concurrent_target_table_locks', blockingLockCount, 0);
  }
  if (version90Rows !== 1) failure(failures, 'schema_90_ledger_rows', version90Rows, 1);

  let disposition = 'blocked';
  if (!alreadyApplied) {
    if (maxVersion !== 90) failure(failures, 'max_schema_version', maxVersion, 90);
    if (version91Rows !== 0) failure(failures, 'schema_91_ledger_rows', version91Rows, 0);
    if (columns.length !== 0) {
      failure(
        failures,
        'schema_91_columns_absent_before_apply',
        columns.map((row) => `${row.table_name}.${row.column_name}`).sort(),
        [],
      );
    }
    if (constraints.length !== 0) {
      failure(
        failures,
        'schema_91_constraint_absent_before_apply',
        constraints.map((row) => row.constraint_name).sort(),
        [],
      );
    }
    if (indexes.length !== 0) {
      failure(
        failures,
        'schema_91_indexes_absent_before_apply',
        indexes.map((row) => row.index_name).sort(),
        [],
      );
    }
    if (!failures.length) disposition = 'ready_to_apply';
  } else {
    if (maxVersion !== 91) failure(failures, 'max_schema_version', maxVersion, 91);
    if (version91Rows !== 1) failure(failures, 'schema_91_ledger_rows', version91Rows, 1);

    for (const expected of expectedColumns) {
      const actual = columns.find((row) => (
        row.table_name === expected.table_name && row.column_name === expected.column_name
      ));
      if (!actual) {
        failure(
          failures,
          `column_exists:${expected.table_name}.${expected.column_name}`,
          false,
          true,
        );
      } else if (
        actual.data_type !== expected.data_type
        || actual.is_nullable !== expected.is_nullable
      ) {
        failure(
          failures,
          `column_contract:${expected.table_name}.${expected.column_name}`,
          { data_type: actual.data_type, is_nullable: actual.is_nullable },
          { data_type: expected.data_type, is_nullable: expected.is_nullable },
        );
      }
    }

    const entryConstraint = constraints.filter(
      (row) => row.constraint_name === 'chat_messages_entry_type_check_v91',
    );
    if (entryConstraint.length !== 1) {
      failure(failures, 'entry_type_constraint_count', entryConstraint.length, 1);
    } else {
      if (!entryConstraint[0].validated) {
        failure(failures, 'entry_type_constraint_validated', false, true);
      }
      const values = quotedValues(entryConstraint[0].definition);
      if (JSON.stringify(values) !== JSON.stringify(ENTRY_TYPES)) {
        failure(failures, 'entry_type_constraint_values', values, ENTRY_TYPES);
      }
    }

    for (const [name, contract] of Object.entries(INDEXES)) {
      const actual = indexes.find((row) => row.index_name === name);
      if (!actual) {
        failure(failures, `index_exists:${name}`, false, true);
        continue;
      }
      if (Boolean(actual.unique) !== contract.unique) {
        failure(failures, `index_unique:${name}`, Boolean(actual.unique), contract.unique);
      }
      if (!actual.valid || !actual.ready) {
        failure(
          failures,
          `index_ready:${name}`,
          { valid: Boolean(actual.valid), ready: Boolean(actual.ready) },
          { valid: true, ready: true },
        );
      }
      const definition = normalizeSql(actual.definition);
      for (const fragment of contract.fragments) {
        if (!definition.includes(fragment)) {
          failure(failures, `index_definition:${name}`, definition, fragment);
        }
      }
    }
    if (!failures.length) disposition = 'already_applied_exact';
  }

  return {
    schema_id: 'xlooop.migration_091_select_preflight.v1',
    status: failures.length ? 'blocked' : 'pass',
    disposition,
    ready_to_apply: disposition === 'ready_to_apply',
    database_name: snapshot.database_name || null,
    database_user: snapshot.database_user || null,
    max_version: maxVersion,
    version_90_rows: version90Rows,
    version_91_rows: version91Rows,
    target_tables: TABLES.map((table) => ({
      table,
      exists: Boolean(snapshot.table_exists?.[table]),
      owner: tableOwners.find((row) => row.table_name === table)?.table_owner || null,
    })),
    observed: {
      column_count: columns.length,
      constraint_count: constraints.length,
      index_count: indexes.length,
      blocking_lock_count: blockingLockCount,
    },
    failures,
  };
}

function predecessorFixture() {
  return {
    database_name: 'fixture',
    database_user: 'fixture_owner',
    max_version: 90,
    version_90_rows: 1,
    version_91_rows: 0,
    table_exists: Object.fromEntries(TABLES.map((table) => [table, true])),
    table_owners: TABLES.map((table) => ({
      table_name: table,
      table_owner: 'fixture_owner',
      migration_role_can_alter: true,
    })),
    columns: [],
    constraints: [],
    indexes: [],
    blocking_lock_count: 0,
  };
}

function poststateFixture() {
  const base = predecessorFixture();
  return {
    ...base,
    max_version: 91,
    version_91_rows: 1,
    columns: expectedColumnRows(),
    constraints: [{
      constraint_name: 'chat_messages_entry_type_check_v91',
      validated: true,
      definition:
        "CHECK (entry_type IS NULL OR entry_type IN ('user_request', 'assistant_answer', "
        + "'resolution_preview', 'execution_outcome', 'system_failure'))",
    }],
    indexes: Object.entries(INDEXES).map(([indexName, contract]) => ({
      index_name: indexName,
      unique: contract.unique,
      valid: true,
      ready: true,
      definition: `CREATE ${contract.unique ? 'UNIQUE ' : ''}INDEX ${indexName} `
        + `ON public.fixture ${contract.fragments.join(' WHERE ')}`,
    })),
  };
}

async function selfTest() {
  const cases = [
    ['exact_predecessor_ready', predecessorFixture(), 'pass', 'ready_to_apply'],
    ['exact_poststate', poststateFixture(), 'pass', 'already_applied_exact'],
    [
      'partial_column_blocked',
      {
        ...predecessorFixture(),
        columns: [{
          table_name: 'chat_messages',
          column_name: 'interaction_id',
          data_type: 'text',
          is_nullable: 'YES',
        }],
      },
      'blocked',
      'blocked',
    ],
    [
      'wrong_owner_blocked',
      {
        ...predecessorFixture(),
        table_owners: predecessorFixture().table_owners.map((row, index) => (
          index === 0 ? { ...row, migration_role_can_alter: false } : row
        )),
      },
      'blocked',
      'blocked',
    ],
    [
      'lock_blocked',
      { ...predecessorFixture(), blocking_lock_count: 1 },
      'blocked',
      'blocked',
    ],
    [
      'false_ledger_blocked',
      { ...poststateFixture(), columns: [] },
      'blocked',
      'blocked',
    ],
  ];
  const failures = [];
  for (const [id, snapshot, status, disposition] of cases) {
    const result = classifyMigration091Preflight(snapshot);
    if (result.status !== status || result.disposition !== disposition) {
      failures.push(
        `${id}: expected ${status}/${disposition}, got ${result.status}/${result.disposition}`,
      );
    }
  }

  const source = await import('node:fs').then(({ readFileSync }) => (
    readFileSync(new URL(import.meta.url), 'utf8')
  ));
  const sqlTemplates = [...source.matchAll(/await\s+sql`([\s\S]*?)`/g)]
    .map((match) => match[1].trim());
  if (sqlTemplates.length !== 6) {
    failures.push(`SELECT-only SQL inventory expected 6 templates, got ${sqlTemplates.length}`);
  }
  for (const [index, sql] of sqlTemplates.entries()) {
    if (!/^SELECT\b/i.test(sql)) failures.push(`SQL template ${index + 1} is not SELECT-only`);
    if (/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(sql)) {
      failures.push(`SQL template ${index + 1} contains a mutating keyword`);
    }
  }

  if (failures.length) {
    console.error(`preflight-migration-091 self-test FAIL: ${failures.join('; ')}`);
    process.exit(4);
  }
  console.log(
    'preflight-migration-091 self-test PASS - SELECT-only SQL, exact predecessor, '
    + 'partial-state, ownership, lock, false-ledger, and exact poststate controls',
  );
}

async function readSnapshot() {
  if (!process.env.DATABASE_URL && !process.env.XLOOOP_SCHEMA91_PG_URL) {
    throw new Error(
      'DATABASE_URL is required (or XLOOOP_SCHEMA91_PG_URL for local PostgreSQL verification); '
      + 'no database query was attempted',
    );
  }
  let close = async () => {};
  let sql;
  if (process.env.XLOOOP_SCHEMA91_PG_URL) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.XLOOOP_SCHEMA91_PG_URL });
    close = () => pool.end();
    sql = async (strings, ...values) => {
      let text = strings[0];
      for (let index = 0; index < values.length; index += 1) {
        text += `$${index + 1}${strings[index + 1]}`;
      }
      return (await pool.query(text, values)).rows;
    };
  } else {
    const { neon } = await import('@neondatabase/serverless');
    sql = neon(process.env.DATABASE_URL);
  }

  try {
    const metadataRows = await sql`
    SELECT
      current_database() AS database_name,
      current_user AS database_user,
      COALESCE(MAX(version), 0)::int AS max_version,
      COUNT(*) FILTER (WHERE version = 90)::int AS version_90_rows,
      COUNT(*) FILTER (WHERE version = 91)::int AS version_91_rows,
      to_regclass('public.intake_resolutions') IS NOT NULL AS intake_resolutions_exists,
      to_regclass('public.governed_execution_receipts') IS NOT NULL
        AS governed_execution_receipts_exists,
      to_regclass('public.chat_messages') IS NOT NULL AS chat_messages_exists
    FROM workers_schema_version
  `;
    const metadata = metadataRows[0];
    const tableExists = {
      intake_resolutions: Boolean(metadata.intake_resolutions_exists),
      governed_execution_receipts: Boolean(metadata.governed_execution_receipts_exists),
      chat_messages: Boolean(metadata.chat_messages_exists),
    };
    if (Object.values(tableExists).some((exists) => !exists)) {
      return {
        ...metadata,
        table_exists: tableExists,
        table_owners: [],
        columns: [],
        constraints: [],
        indexes: [],
        blocking_lock_count: 0,
      };
    }

    const ownerRows = await sql`
    SELECT
      cls.relname AS table_name,
      pg_get_userbyid(cls.relowner) AS table_owner,
      pg_has_role(current_user, cls.relowner, 'MEMBER') AS migration_role_can_alter
    FROM pg_class AS cls
    WHERE cls.oid IN (
      'intake_resolutions'::regclass,
      'governed_execution_receipts'::regclass,
      'chat_messages'::regclass
    )
    ORDER BY cls.relname
  `;
    const columnRows = await sql`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        'intake_resolutions',
        'governed_execution_receipts',
        'chat_messages'
      )
      AND column_name IN (
        'interaction_id',
        'entry_type',
        'resolution_id',
        'execution_receipt_id',
        'packet_id',
        'operation_event_id',
        'intent_id',
        'audit_event_id',
        'projection_outbox_id',
        'conversation_message_id',
        'closing_attestation_id'
      )
    ORDER BY table_name, column_name
  `;
    const constraintRows = await sql`
    SELECT
      con.conname AS constraint_name,
      con.convalidated AS validated,
      pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint AS con
    WHERE con.conrelid = 'chat_messages'::regclass
      AND con.conname = 'chat_messages_entry_type_check_v91'
  `;
    const indexRows = await sql`
    SELECT
      idx.relname AS index_name,
      ind.indisunique AS unique,
      ind.indisvalid AS valid,
      ind.indisready AS ready,
      pg_get_indexdef(ind.indexrelid) AS definition
    FROM pg_index AS ind
    JOIN pg_class AS idx ON idx.oid = ind.indexrelid
    WHERE idx.relname IN (
      'chat_messages_interaction_entry_key',
      'chat_messages_execution_receipt',
      'chat_messages_resolution',
      'intake_resolutions_interaction',
      'governed_execution_receipts_interaction'
    )
    ORDER BY idx.relname
  `;
    const lockRows = await sql`
    SELECT COUNT(*)::int AS blocking_lock_count
    FROM pg_locks AS locks
    JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
    WHERE locks.relation IN (
      'intake_resolutions'::regclass,
      'governed_execution_receipts'::regclass,
      'chat_messages'::regclass
    )
      AND locks.pid <> pg_backend_pid()
      AND activity.state <> 'idle'
  `;

    const targetColumnRows = columnRows.filter((row) => (
      Object.hasOwn(COLUMNS[row.table_name] || {}, row.column_name)
    ));
    return {
      ...metadata,
      table_exists: tableExists,
      table_owners: ownerRows,
      columns: targetColumnRows,
      constraints: constraintRows,
      indexes: indexRows,
      blocking_lock_count: lockRows[0]?.blocking_lock_count || 0,
    };
  } finally {
    await close();
  }
}

async function main() {
  if (SELF_TEST) return selfTest();

  let result;
  try {
    result = classifyMigration091Preflight(await readSnapshot());
  } catch (error) {
    result = {
      schema_id: 'xlooop.migration_091_select_preflight.v1',
      status: 'blocked',
      disposition: 'query_failed',
      ready_to_apply: false,
      failures: [{
        id: 'query',
        actual: error instanceof Error ? error.message : String(error),
        expected: 'successful SELECT-only preflight',
      }],
    };
  }

  if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
  else if (result.status === 'pass') {
    console.log(
      `PASS migration 091 SELECT-only preflight - ${result.disposition} `
      + `- schema ${result.max_version}`,
    );
  } else {
    console.error(
      `FAIL migration 091 SELECT-only preflight - ${result.disposition} - `
      + result.failures.map((item) => item.id).join(', '),
    );
  }
  process.exit(result.status === 'pass' ? 0 : 2);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
