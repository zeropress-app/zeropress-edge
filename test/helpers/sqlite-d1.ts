import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Only disposable test databases use these artifacts. This is not an Edge DB
// installer and never opens a local Wrangler database or a Cloudflare resource.
export const installSql = [
  readFileSync(new URL('../../database/install/001_edge_baseline.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../../database/install/002_edge_seed.sql', import.meta.url), 'utf8'),
];

class SqliteStatement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: SQLInputValue[]) {
    return new SqliteStatement(this.sqlite, this.sql, values);
  }

  execute<T>(): D1Result<T> {
    const statement = this.sqlite.prepare(this.sql);
    // This also preserves rows from INSERT/UPDATE ... RETURNING inside batch().
    const results = statement.columns().length ? statement.all(...this.values) : [];
    if (!statement.columns().length) statement.run(...this.values);
    const { changes } = this.sqlite.prepare('SELECT changes() AS changes').get()!;
    // Production code uses results/success/changes; timing and storage metrics
    // are deliberately outside the scope of this SQLite adapter.
    return { success: true, results, meta: { changes: Number(changes) } } as D1Result<T>;
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...this.values);
    if (!row) return null;
    if (column !== undefined && !(column in row)) throw new Error(`Unknown column: ${column}`);
    return (column === undefined ? row : row[column]) as T;
  }

  async all<T>() { return this.execute<T>(); }
  async run<T>() { return this.execute<T>(); }
}

export function createSqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const sql of installSql) sqlite.exec(sql);

  const db = {
    prepare: (sql: string) => new SqliteStatement(sqlite, sql),
    async batch<T>(statements: SqliteStatement[]): Promise<D1Result<T>[]> {
      // Execute synchronously inside one transaction so parallel callers cannot
      // interleave batches. A constraint failure rolls back every statement.
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement.execute<T>());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { sqlite, db };
}
