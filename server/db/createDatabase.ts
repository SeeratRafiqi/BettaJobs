import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export async function createDatabase() {
  const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  const finalDbName = url?.pathname.slice(1) || process.env.DB_NAME || 'jobseek';
  const dbUser = decodeURIComponent(url?.username || process.env.DB_USER || 'postgres');
  const dbPassword = decodeURIComponent(url?.password || process.env.DB_PASSWORD || '');
  const host = url?.hostname || process.env.DB_HOST || 'localhost';
  const port = parseInt(url?.port || process.env.DB_PORT || '5432', 10);

  const sequelize = new Sequelize('postgres', dbUser, dbPassword, {
    host,
    port,
    dialect: 'postgres',
    logging: false,
  });

  try {
    await sequelize.authenticate();
    console.log('Connected to PostgreSQL server');

    const [results] = await sequelize.query(
      'SELECT 1 FROM pg_database WHERE datname = ?',
      { replacements: [finalDbName] },
    );

    if (Array.isArray(results) && results.length === 0) {
      await sequelize.query(`CREATE DATABASE ${quoteIdentifier(finalDbName)}`);
      console.log(`Database '${finalDbName}' created successfully`);
    } else {
      console.log(`Database '${finalDbName}' already exists`);
    }
  } catch (error: any) {
    console.error('Failed to create database:', error.message);
    console.error('\nPlease create the database manually:');
    console.error(`CREATE DATABASE ${quoteIdentifier(finalDbName)};`);
    throw error;
  } finally {
    await sequelize.close().catch(() => undefined);
  }
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('/createDatabase.ts');

if (isDirectRun) {
  createDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
