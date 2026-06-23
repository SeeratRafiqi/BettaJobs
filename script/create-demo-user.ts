import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import sequelize from '../server/db/config.js';
import { User } from '../server/db/models/User.js';
import { Candidate } from '../server/db/models/Candidate.js';

const email = 'demo@demo.com';
const password = 'demo1234';
const name = 'Demo Candidate';

await sequelize.authenticate();
const hash = await bcrypt.hash(password, 10);
const [user, created] = await User.findOrCreate({
  where: { email },
  defaults: {
    id: randomUUID(),
    username: email,
    email,
    password: hash,
    name,
    role: 'candidate',
  },
});

if (created) {
  await Candidate.create({
    id: randomUUID(),
    user_id: user.id,
    name,
    email,
    country: 'US',
    country_code: 'US',
    headline: 'Demo candidate for interview',
  });
  console.log('Created demo candidate user');
} else {
  console.log('Demo user already exists');
}

console.log(`Login: ${email} / ${password}`);
await sequelize.close();
