import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';

dotenv.config();

async function createDatabase() {
  // Connect without specifying database
  const connectionConfig: any = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    dialect: 'mysql',
    logging: false,
  };

  const dbName = process.env.DB_NAME || 'cv_matcher';
  const dbUser = process.env.DB_USER || 'wu_user';
  const dbPassword = process.env.DB_PASSWORD || '';

  // Parse DATABASE_URL if provided
  let sequelize: Sequelize;
  let finalDbName = dbName;
  
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    finalDbName = url.pathname.slice(1); // Remove leading '/'
    
    // Connect to MySQL server (without database)
    sequelize = new Sequelize({
      host: url.hostname,
      port: parseInt(url.port || '3306', 10),
      username: url.username,
      password: url.password,
      dialect: 'mysql',
      logging: false,
    });
  } else {
    sequelize = new Sequelize('', dbUser, dbPassword, connectionConfig);
  }

  try {
    // Test connection
    await sequelize.authenticate();
    console.log('✓ Connected to MySQL server');

    // Check if database exists
    const [results] = await sequelize.query(
      `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '${finalDbName}'`
    );

    if (Array.isArray(results) && results.length === 0) {
      // Database doesn't exist, create it
      await sequelize.query(`CREATE DATABASE \`${finalDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      console.log(`✓ Database '${finalDbName}' created successfully`);
    } else {
      console.log(`✓ Database '${finalDbName}' already exists`);
    }

    await sequelize.close();
    process.exit(0);
  } catch (error: any) {
    console.error('Failed to create database:', error.message);
    console.error('\nPlease create the database manually:');
    console.error(`CREATE DATABASE ${finalDbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    process.exit(1);
  }
}

createDatabase();
