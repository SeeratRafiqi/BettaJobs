/**
 * Resolves which DB dialect server/db/config.ts will use.
 * Config currently wires Sequelize for PostgreSQL only.
 */
export type ResolvedDialect = 'postgres';

export function getResolvedDialect(): ResolvedDialect {
  if (process.env.USE_SQLITE === 'true') {
    throw new Error(
      'USE_SQLITE=true is not supported by server/db/config.ts. Set USE_SQLITE=false and use PostgreSQL (DB_* vars or DATABASE_URL).',
    );
  }

  const url = process.env.DATABASE_URL?.trim();
  if (url && !/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error(
      'DATABASE_URL must be a postgres:// or postgresql:// URL when using server/db/config.ts.',
    );
  }

  const d = process.env.DB_DIALECT?.toLowerCase();
  if (d && d !== 'postgres' && d !== 'postgresql') {
    throw new Error(
      `Unsupported DB_DIALECT="${process.env.DB_DIALECT}". Only postgres is supported.`,
    );
  }

  return 'postgres';
}
