/**
 * Inspect duplicate PostgreSQL indexes on the users table.
 *
 * Usage: tsx server/db/fixIndexes.ts
 */

import sequelize from './config.js';
import { QueryTypes } from 'sequelize';

interface IndexRow {
  index_name: string;
  column_names: string;
  is_unique: boolean;
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function fixIndexes() {
  try {
    await sequelize.authenticate();
    console.log('Database connection established');

    const dbName = sequelize.getDatabaseName();
    console.log(`\nChecking indexes in PostgreSQL database: ${dbName}\n`);

    const indexes = await sequelize.query(
      `
        SELECT
          i.relname AS index_name,
          array_to_string(array_agg(a.attname ORDER BY a.attnum), ',') AS column_names,
          ix.indisunique AS is_unique
        FROM pg_class t
        JOIN pg_index ix ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'users'
        GROUP BY i.relname, ix.indisunique
        ORDER BY i.relname
      `,
      { type: QueryTypes.SELECT },
    ) as IndexRow[];

    if (indexes.length === 0) {
      console.log('No indexes found on users table. The table may not exist yet.');
      await sequelize.close();
      process.exit(0);
    }

    console.log(`Found ${indexes.length} indexes on users table\n`);
    indexes.forEach((idx) => {
      console.log(`  - ${idx.index_name} (${idx.is_unique ? 'UNIQUE' : 'INDEX'}): [${idx.column_names}]`);
    });

    const bySignature = new Map<string, IndexRow[]>();
    indexes.forEach((idx) => {
      const signature = `${idx.is_unique}:${idx.column_names}`;
      bySignature.set(signature, [...(bySignature.get(signature) || []), idx]);
    });

    const duplicates = [...bySignature.values()]
      .filter((group) => group.length > 1)
      .flatMap((group) =>
        group
          .sort((a, b) => a.index_name.length - b.index_name.length)
          .slice(1),
      );

    if (duplicates.length === 0) {
      console.log('\nNo duplicate indexes found.');
    } else {
      console.log(`\nFound ${duplicates.length} duplicate indexes. Review, back up if needed, then run:`);
      duplicates.forEach((idx) => {
      console.log(`ALTER TABLE users DROP CONSTRAINT IF EXISTS ${quoteIdentifier(idx.index_name)};`);
      });
    }

    await sequelize.close();
    process.exit(0);
  } catch (error: any) {
    console.error('Error:', error.message);
    console.error('Full error:', error);
    await sequelize.close();
    process.exit(1);
  }
}

fixIndexes();
