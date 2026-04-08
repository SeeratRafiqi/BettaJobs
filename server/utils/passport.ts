import passport from 'passport';
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import { randomUUID } from 'node:crypto';
import { User } from '../db/models/User.js';
import { Candidate } from '../db/models/Candidate.js';
import sequelize from '../db/config.js';
import { googleOAuthCallbackUrl } from './frontendBase.js';

function profileDisplayName(profile: Profile, email: string): string {
  const n = profile.displayName?.trim();
  if (n) return n;
  const given = profile.name?.givenName?.trim();
  const family = profile.name?.familyName?.trim();
  const combined = [given, family].filter(Boolean).join(' ').trim();
  if (combined) return combined;
  const local = email.split('@')[0];
  return local || 'User';
}

passport.serializeUser((user: Express.User, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const row = await User.findByPk(id);
    done(null, row ?? undefined);
  } catch (e) {
    done(e as Error);
  }
});

const clientID = process.env.GOOGLE_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

if (clientID && clientSecret) {
  passport.use(
    new GoogleStrategy(
      {
        clientID,
        clientSecret,
        callbackURL: googleOAuthCallbackUrl(),
      },
      async (accessToken: string, refreshToken: string, profile: Profile, done) => {
        try {
          const googleEmailRaw = profile.emails?.[0]?.value;
          if (!googleEmailRaw) {
            return done(new Error('Your Google account has no email address. Add one to your Google profile and try again.'));
          }
          const email = googleEmailRaw.toLowerCase();
          const googleAvatar = profile.photos?.[0]?.value ?? null;
          const name = profileDisplayName(profile, email);

          let user = await User.findOne({ where: { googleId: profile.id } });
          if (user) {
            const patch: Record<string, unknown> = {};
            if (name && user.name !== name) patch.name = name;
            if (googleAvatar && !user.avatar) patch.avatar = googleAvatar;
            if (!user.email_verified) patch.email_verified = true;
            if (Object.keys(patch).length > 0) {
              await user.update(patch);
              await user.reload();
            }
            return done(null, user);
          }

          user = await User.findOne({ where: { email } });
          if (user) {
            await user.update({
              googleId: profile.id,
              avatar: user.avatar ?? googleAvatar,
              email_verified: true,
            });
            await user.reload();
            return done(null, user);
          }

          await sequelize.transaction(async (t) => {
            user = await User.create(
              {
                id: randomUUID(),
                name,
                email,
                googleId: profile.id,
                avatar: googleAvatar,
                password: null,
                username: email,
                role: 'candidate',
                email_verified: true,
              },
              { transaction: t }
            );
            await Candidate.create(
              {
                id: randomUUID(),
                user_id: user.id,
                name,
                email,
                phone: '',
                country: '',
                country_code: '',
              },
              { transaction: t }
            );
          });

          return done(null, user!);
        } catch (err) {
          return done(err as Error);
        }
      }
    )
  );
}

export default passport;
