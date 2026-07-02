import sequelize from './config.js';
import { QueryTypes } from 'sequelize';

async function verifyTables() {
  try {
    await sequelize.authenticate();
    console.log('Database connection established\n');

    const tables = await sequelize.query(
      `
        SELECT tablename AS table_name
        FROM pg_catalog.pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
      `,
      { type: QueryTypes.SELECT },
    ) as Array<{ table_name: string }>;

    console.log(`Found ${tables.length} tables in database:\n`);

    if (tables.length === 0) {
      console.log('No tables found.');
      console.log('Run: npm run db:migrate');
    } else {
      tables.forEach((table) => {
        console.log(`  - ${table.table_name}`);
      });
    }

    const requiredTables = [
      'users',
      'candidates',
      'cv_files',
      'candidate_matrices',
      'jobs',
      'job_matrices',
      'matches',
      'admin_notes',
      'candidate_tags',
    ];

    console.log('\nRequired tables check:');
    const existingTableNames = tables.map((t) => t.table_name);
    let allPresent = true;

    requiredTables.forEach((table) => {
      if (existingTableNames.includes(table)) {
        console.log(`  - ${table}`);
      } else {
        console.log(`  - ${table} MISSING`);
        allPresent = false;
      }
    });

    if (!allPresent) {
      console.log('\nSome tables are missing. Run: npm run db:migrate');
      process.exit(1);
    } else {
      console.log('\nAll required tables exist.');
    }

    await sequelize.close();
    process.exit(0);
  } catch (error: any) {
    console.error('Verification failed:', error.message);
    process.exit(1);
  }
}

verifyTables();
