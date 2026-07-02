import '../loadEnv.js';
import sequelize from './config.js';
import { createDatabase } from './createDatabase.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function runNpmScript(script: string) {
  const { stdout, stderr } = await execAsync(`npm run ${script}`, {
    cwd: process.cwd(),
    env: process.env,
  });

  if (stdout) {
    console.log(stdout.trim());
  }
  if (stderr) {
    console.error(stderr.trim());
  }
}

/** Create/connect to the database and optionally run migrations from env flags. */
export async function initializeDatabase(): Promise<void> {
  if (process.env.SKIP_SETUP === 'true') {
    console.log('Database setup skipped (SKIP_SETUP=true)');
    return;
  }

  if (process.env.AUTO_CREATE_DB !== 'false') {
    await createDatabase();
  }

  if (process.env.AUTO_MIGRATE !== 'false') {
    await runNpmScript('db:migrate');
  }

  await sequelize.authenticate();
}
