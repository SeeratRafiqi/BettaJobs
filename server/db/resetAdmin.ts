import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import sequelize from './config.js';
import { User } from './models/User.js';

dotenv.config();

const username = process.env.ADMIN_USERNAME || 'admin';
const email = process.env.ADMIN_EMAIL || 'admin@example.com';
const password = process.env.ADMIN_PASSWORD || 'admin123';
const name = process.env.ADMIN_NAME || 'Admin User';

async function resetAdmin() {
  await sequelize.authenticate();

  const hashedPassword = await bcrypt.hash(password, 10);
  const existing =
    (await User.findOne({ where: { username } })) ||
    (await User.findOne({ where: { email } }));

  if (existing) {
    await existing.update({
      username,
      email,
      password: hashedPassword,
      role: 'admin',
      name,
      email_verified: true,
      updated_at: new Date(),
    });
    console.log(`Updated admin user: ${username} (${email})`);
  } else {
    await User.create({
      id: randomUUID(),
      username,
      email,
      password: hashedPassword,
      role: 'admin',
      name,
      email_verified: true,
      created_at: new Date(),
      updated_at: new Date(),
    });
    console.log(`Created admin user: ${username} (${email})`);
  }

  await sequelize.close();
}

resetAdmin()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('Failed to reset admin user:', error?.message ?? error);
    await sequelize.close().catch(() => undefined);
    process.exit(1);
  });
