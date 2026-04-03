import '../loadEnv.js';
import sequelize from './config.js';

/** Connect to the database. Run `npm run db:migrate` to sync tables from Sequelize models. */
export async function initializeDatabase(): Promise<void> {
  if (process.env.SKIP_SETUP === 'true') {
    console.log('⏭️  Database setup skipped (SKIP_SETUP=true)');
    return;
  }

  await sequelize.authenticate();
}
