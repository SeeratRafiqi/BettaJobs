import sequelize from './config.js';
import { DataTypes } from 'sequelize';
import {
  User,
  Candidate,
  CompanyProfile,
  CvFile,
  CandidateMatrix,
  Job,
  JobMatrix,
  Match,
  Application,
  AdminNote,
  CandidateTag,
  JobReport,
  PipelineStage,
  Notification,
  ApplicationHistory,
  Conversation,
  Message,
  SavedJob,
  CompanyMember,
  CoverLetter,
  TailoredResume,
  VoiceInterviewSession,
  InterviewAssessment,
  InterviewQuestion,
  InterviewAttempt,
  InterviewAnswer,
  InterviewReport,
  UsageLog,
} from './models/index.js';

// Helper: safely add a column (ignores 'Duplicate column' errors)
async function addColumn(table: string, column: string, sql: string) {
  try {
    await sequelize.query(sql);
    console.log(`  ✓ Added ${table}.${column}`);
  } catch (err: any) {
    if (err.message?.includes('Duplicate column')) {
      console.log(`  ✓ ${table}.${column} already exists`);
    } else {
      console.warn(`  ⚠️ ${table}.${column} skipped: ${err.message?.substring(0, 120)}`);
    }
  }
}

// Helper: safely modify a column / ENUM (logs warning on failure)
async function modifyColumn(table: string, column: string, sql: string) {
  try {
    await sequelize.query(sql);
    console.log(`  ✓ Modified ${table}.${column}`);
  } catch (err: any) {
    console.warn(`  ⚠️ ${table}.${column} modify skipped: ${err.message?.substring(0, 120)}`);
  }
}

// Helper: safely add an index (ignores 'Duplicate key name' errors)
async function addIndex(table: string, indexName: string, sql: string) {
  try {
    await sequelize.query(sql);
    console.log(`  ✓ Added index ${indexName} on ${table}`);
  } catch (err: any) {
    if (err.message?.includes('Duplicate key name') || err.message?.includes('Duplicate entry')) {
      console.log(`  ✓ Index ${indexName} already exists on ${table}`);
    } else {
      console.warn(`  ⚠️ Index ${indexName} skipped: ${err.message?.substring(0, 120)}`);
    }
  }
}

async function migrate() {
  try {
    console.log('Starting database migration...');

    // Test connection first
    await sequelize.authenticate();
    console.log('✓ Database connection established');

    // Ensure all models are loaded
    console.log('Loading models...');

    // Check if we should force recreate (only in development)
    const FORCE_RECREATE = process.env.FORCE_RECREATE_TABLES === 'true';

    // ===================================================================
    // STEP 1: CREATE / SYNC ALL TABLES
    // ===================================================================
    // Models are ordered by dependency (parents first, children after).
    // We use `alter: true` only for dialects where Sequelize can do it safely,
    // with a fallback to `alter: false` (create-only) if alter fails
    // with a fallback to `alter: false` (create-only) if alter fails.
    // ===================================================================

    const dialect = sequelize.getDialect();
    const isSqlite = dialect === 'sqlite';
    const useAlter = false; // PostgreSQL alter:true can create duplicate unique indexes.

    if (dialect === 'postgres') {
      await sequelize.query(`
        DO $$
        BEGIN
          IF to_regclass('public.users') IS NOT NULL THEN
            ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();
            ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();
            UPDATE users SET username = COALESCE(username, email, id) WHERE username IS NULL;
            UPDATE users SET role = 'candidate' WHERE role IS NULL;
            UPDATE users SET email = COALESCE(email, username, id || '@example.local') WHERE email IS NULL;
            UPDATE users SET name = COALESCE(name, username, email, 'User') WHERE name IS NULL;
            UPDATE users SET password = '' WHERE password IS NULL;
            ALTER TABLE users ALTER COLUMN username SET NOT NULL;
            ALTER TABLE users ALTER COLUMN password SET NOT NULL;
            ALTER TABLE users ALTER COLUMN role SET NOT NULL;
            ALTER TABLE users ALTER COLUMN email SET NOT NULL;
            ALTER TABLE users ALTER COLUMN name SET NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (username);
            CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);
          END IF;

          IF to_regclass('public.messages') IS NOT NULL THEN
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_id VARCHAR(36);
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_id VARCHAR(36);
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS content TEXT;
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS read BOOLEAN NOT NULL DEFAULT false;
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();
            CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages (conversation_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_id);
          END IF;
        END $$;
      `);
    }

    const models = [
      { name: 'User', model: User, table: 'users' },
      { name: 'Candidate', model: Candidate, table: 'candidates' },
      { name: 'CompanyProfile', model: CompanyProfile, table: 'company_profiles' },
      { name: 'CvFile', model: CvFile, table: 'cv_files' },
      { name: 'CandidateMatrix', model: CandidateMatrix, table: 'candidate_matrices' },
      { name: 'Job', model: Job, table: 'jobs' },
      { name: 'JobMatrix', model: JobMatrix, table: 'job_matrices' },
      { name: 'Match', model: Match, table: 'matches' },
      { name: 'PipelineStage', model: PipelineStage, table: 'pipeline_stages' },
      { name: 'Application', model: Application, table: 'applications' },
      { name: 'AdminNote', model: AdminNote, table: 'admin_notes' },
      { name: 'CandidateTag', model: CandidateTag, table: 'candidate_tags' },
      { name: 'JobReport', model: JobReport, table: 'job_reports' },
      { name: 'Notification', model: Notification, table: 'notifications' },
      { name: 'ApplicationHistory', model: ApplicationHistory, table: 'application_history' },
      { name: 'Conversation', model: Conversation, table: 'conversations' },
      { name: 'Message', model: Message, table: 'messages' },
      { name: 'SavedJob', model: SavedJob, table: 'saved_jobs' },
      { name: 'CompanyMember', model: CompanyMember, table: 'company_members' },
      { name: 'CoverLetter', model: CoverLetter, table: 'cover_letters' },
      { name: 'TailoredResume', model: TailoredResume, table: 'tailored_resumes' },
      { name: 'VoiceInterviewSession', model: VoiceInterviewSession, table: 'voice_interview_sessions' },
      { name: 'InterviewAssessment', model: InterviewAssessment, table: 'interview_assessments' },
      { name: 'InterviewQuestion', model: InterviewQuestion, table: 'interview_questions' },
      { name: 'InterviewAttempt', model: InterviewAttempt, table: 'interview_attempts' },
      { name: 'InterviewAnswer', model: InterviewAnswer, table: 'interview_answers' },
      { name: 'InterviewReport', model: InterviewReport, table: 'interview_reports' },
      { name: 'UsageLog', model: UsageLog, table: 'usage_logs' },
    ];

    if (FORCE_RECREATE) {
      console.log('⚠️  FORCE_RECREATE enabled — dropping and recreating all tables...');
      for (const { name, model } of models) {
        await model.sync({ force: true });
        console.log(`  ✓ ${name} table recreated`);
      }
    } else {
      console.log('\nSyncing tables (' + (useAlter ? 'alter: true with fallback' : 'create-only') + ')...');
      for (const { name, model, table } of models) {
        try {
          await model.sync({ alter: useAlter });
          console.log(`  ✓ ${name} table synced`);
        } catch (error: any) {
          const msg = error.message || '';
          const parentMsg = error.parent?.message || '';
          if (msg.includes('index limit') || parentMsg.includes('index limit')) {
            console.warn(`  ⚠️ ${name}: index limit reached; falling back to create-only`);
            try {
              await sequelize.getQueryInterface().describeTable(table);
              console.log(`  ✓ ${name} table exists (skipped alter)`);
            } catch {
              await model.sync({ alter: false });
              console.log(`  ✓ ${name} table created (no alter)`);
            }
          } else if (msg.includes("doesn't exist") || parentMsg.includes("doesn't exist")) {
            // Referenced table might not exist yet — try create-only
            await model.sync({ alter: false });
            console.log(`  ✓ ${name} table created`);
          } else {
            // Log warning but continue to let patches try to fix things
            console.warn(`  ⚠️ ${name} sync error: ${msg.substring(0, 150)}`);
            try {
              await model.sync({ alter: false });
              console.log(`  ✓ ${name} table created (fallback)`);
            } catch {
              console.warn(`  ⚠️ ${name} fallback also failed — patches will attempt to fix`);
            }
          }
        }
      }
    }

    // ===================================================================
    // STEP 2: LEGACY SCHEMA PATCHES (disabled in PostgreSQL config)
    // These handle ENUM changes and columns that `alter: true` may miss.
    // Skipped in the current PostgreSQL runtime; model sync above owns schema updates.
    // ===================================================================
    if (false) {
      console.log('\nApplying schema patches...');

    // ---------- users ----------
    console.log('\n[users]');
    modifyColumn('users', 'role',
      `ALTER TABLE users ALTER COLUMN role ENUM('admin','candidate','company') NOT NULL`
    );
    await addColumn('users', 'email_verified',
      `ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT 0`
    );
    await addColumn('users', 'updated_at',
      `ALTER TABLE users ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`
    );
    await addIndex('users', 'idx_users_email',
      `ALTER TABLE users ADD CONSTRAINT idx_users_email UNIQUE (email)`
    );

    // ---------- candidates ----------
    console.log('\n[candidates]');
    await addColumn('candidates', 'user_id',
      `ALTER TABLE candidates ADD COLUMN user_id VARCHAR(36) NULL UNIQUE`
    );
    await addColumn('candidates', 'headline',
      `ALTER TABLE candidates ADD COLUMN headline VARCHAR(500) NULL`
    );
    await addColumn('candidates', 'photo_url',
      `ALTER TABLE candidates ADD COLUMN photo_url VARCHAR(500) NULL`
    );
    await addColumn('candidates', 'bio',
      `ALTER TABLE candidates ADD COLUMN bio TEXT NULL`
    );
    await addColumn('candidates', 'linkedin_url',
      `ALTER TABLE candidates ADD COLUMN linkedin_url VARCHAR(500) NULL`
    );
    await addColumn('candidates', 'github_url',
      `ALTER TABLE candidates ADD COLUMN github_url VARCHAR(500) NULL`
    );
    await addColumn('candidates', 'portfolio_url',
      `ALTER TABLE candidates ADD COLUMN portfolio_url VARCHAR(500) NULL`
    );
    await addColumn('candidates', 'profile_visibility',
      `ALTER TABLE candidates ADD COLUMN profile_visibility ENUM('public','applied_only','hidden') NOT NULL DEFAULT 'public'`
    );
    await addColumn('candidates', 'show_email',
      `ALTER TABLE candidates ADD COLUMN show_email BOOLEAN NOT NULL DEFAULT 0`
    );
    await addColumn('candidates', 'show_phone',
      `ALTER TABLE candidates ADD COLUMN show_phone BOOLEAN NOT NULL DEFAULT 0`
    );
    await addColumn('candidates', 'updated_at',
      `ALTER TABLE candidates ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`
    );

    // ---------- cv_files ----------
    console.log('\n[cv_files]');
    await addColumn('cv_files', 'label',
      `ALTER TABLE cv_files ADD COLUMN label VARCHAR(255) NULL`
    );
    await addColumn('cv_files', 'is_primary',
      `ALTER TABLE cv_files ADD COLUMN is_primary BOOLEAN NOT NULL DEFAULT 0`
    );
    await addColumn('cv_files', 'source_company_id',
      `ALTER TABLE cv_files ADD COLUMN source_company_id VARCHAR(36) NULL`
    );
    await modifyColumn('cv_files', 'status',
      `ALTER TABLE cv_files ALTER COLUMN status ENUM('uploaded','parsing','matrix_ready','failed','needs_review') NOT NULL DEFAULT 'uploaded'`
    );

    // ---------- jobs ----------
    console.log('\n[jobs]');
    await addColumn('jobs', 'company_id',
      `ALTER TABLE jobs ADD COLUMN company_id VARCHAR(36) NULL`
    );
    await addColumn('jobs', 'deadline',
      `ALTER TABLE jobs ADD COLUMN deadline TIMESTAMP NULL`
    );
    await addColumn('jobs', 'is_featured',
      `ALTER TABLE jobs ADD COLUMN is_featured BOOLEAN NOT NULL DEFAULT 0`
    );
    await modifyColumn('jobs', 'seniority_level',
      `ALTER TABLE jobs ALTER COLUMN seniority_level ENUM('internship','junior','mid','senior','lead','principal') NOT NULL`
    );
    await modifyColumn('jobs', 'status',
      `ALTER TABLE jobs ALTER COLUMN status ENUM('draft','published','closed') NOT NULL DEFAULT 'draft'`
    );

    // ---------- matches ----------
    console.log('\n[matches]');
    await addColumn('matches', 'application_id',
      `ALTER TABLE matches ADD COLUMN application_id VARCHAR(36) NULL`
    );

    // ---------- applications ----------
    console.log('\n[applications]');
    await modifyColumn('applications', 'status',
      `ALTER TABLE applications ALTER COLUMN status ENUM('applied','screening','interview','offer','hired','rejected','withdrawn') NOT NULL DEFAULT 'applied'`
    );
    await addColumn('applications', 'pipeline_stage_id',
      `ALTER TABLE applications ADD COLUMN pipeline_stage_id VARCHAR(36) NULL`
    );
    await addColumn('applications', 'cover_letter',
      `ALTER TABLE applications ADD COLUMN cover_letter TEXT NULL`
    );
    await addColumn('applications', 'cv_type',
      `ALTER TABLE applications ADD COLUMN cv_type VARCHAR(20) NULL DEFAULT 'original'`
    );
    await addColumn('applications', 'submitted_cv_text',
      `ALTER TABLE applications ADD COLUMN submitted_cv_text TEXT NULL`
    );
    await addColumn('applications', 'notes',
      `ALTER TABLE applications ADD COLUMN notes JSON NULL`
    );
    await addColumn('applications', 'match_id',
      `ALTER TABLE applications ADD COLUMN match_id VARCHAR(36) NULL`
    );
    await addColumn('applications', 'updated_at',
      `ALTER TABLE applications ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`
    );

    // ---------- notifications ----------
    console.log('\n[notifications]');
    await modifyColumn('notifications', 'type',
      `ALTER TABLE notifications ALTER COLUMN type ENUM(
        'application_received',
        'status_changed',
        'shortlisted',
        'rejected',
        'new_match',
        'message_received',
        'job_expired',
        'interview_assigned',
        'interview_deadline_reminder',
        'interview_expired',
        'interview_report_ready'
      ) NOT NULL`
    );

    // ---------- interview_assessments ----------
    console.log('\n[interview_assessments]');
    await addColumn('interview_assessments', 'reminder_sent_at',
      `ALTER TABLE interview_assessments ADD COLUMN reminder_sent_at TIMESTAMP NULL`
    );
    await addColumn('interview_assessments', 'expiry_notified_at',
      `ALTER TABLE interview_assessments ADD COLUMN expiry_notified_at TIMESTAMP NULL`
    );
    await addColumn('interview_assessments', 'is_active',
      `ALTER TABLE interview_assessments ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT 1`
    );

    // ---------- interview_questions ----------
    console.log('\n[interview_questions]');
    await addColumn('interview_questions', 'order_index',
      `ALTER TABLE interview_questions ADD COLUMN order_index INT NOT NULL DEFAULT 0`
    );

    // ---------- voice_interview_sessions ----------
    console.log('\n[voice_interview_sessions]');
    const dialect = sequelize.getDialect();
    if (dialect === 'sqlite') {
      try {
        await sequelize.getQueryInterface().addColumn('voice_interview_sessions', 'outcome', {
          type: sequelize.Sequelize.TEXT,
          allowNull: true,
        });
        console.log('  ✓ Added voice_interview_sessions.outcome');
      } catch (err: any) {
        if (err?.message?.includes('duplicate') || err?.message?.includes('already exists')) {
          console.log('  ✓ voice_interview_sessions.outcome already exists');
        } else {
          console.warn('  ⚠️ voice_interview_sessions.outcome:', err?.message?.substring(0, 80));
        }
      }
    } else {
      await addColumn('voice_interview_sessions', 'outcome', `ALTER TABLE voice_interview_sessions ADD COLUMN outcome TEXT NULL`);
    }
    if (dialect === 'sqlite') {
      try {
        await sequelize.getQueryInterface().addColumn('voice_interview_sessions', 'duration_minutes', {
          type: DataTypes.INTEGER,
          allowNull: true,
        });
        console.log('  ✓ Added voice_interview_sessions.duration_minutes');
      } catch (err: any) {
        if (err?.message?.includes('duplicate') || err?.message?.includes('already exists')) {
          console.log('  ✓ voice_interview_sessions.duration_minutes already exists');
        } else {
          console.warn('  ⚠️ voice_interview_sessions.duration_minutes:', err?.message?.substring(0, 80));
        }
      }
    } else {
      await addColumn('voice_interview_sessions', 'duration_minutes', `ALTER TABLE voice_interview_sessions ADD COLUMN duration_minutes INT NULL`);
    }
    if (dialect === 'sqlite') {
      try {
        await sequelize.getQueryInterface().addColumn('voice_interview_sessions', 'conductor_state', {
          type: DataTypes.TEXT,
          allowNull: true,
        });
        console.log('  ✓ Added voice_interview_sessions.conductor_state');
      } catch (err: any) {
        if (err?.message?.includes('duplicate') || err?.message?.includes('already exists')) {
          console.log('  ✓ voice_interview_sessions.conductor_state already exists');
        } else {
          console.warn('  ⚠️ voice_interview_sessions.conductor_state:', err?.message?.substring(0, 80));
        }
      }
    } else {
      await addColumn('voice_interview_sessions', 'conductor_state', `ALTER TABLE voice_interview_sessions ADD COLUMN conductor_state TEXT NULL`);
    }

    // ---------- conversations ----------
    console.log('\n[conversations]');
    await addColumn('conversations', 'job_id',
      `ALTER TABLE conversations ADD COLUMN job_id VARCHAR(36) NULL`
    );
    await addColumn('conversations', 'application_id',
      `ALTER TABLE conversations ADD COLUMN application_id VARCHAR(36) NULL`
    );
    await addColumn('conversations', 'last_message_at',
      `ALTER TABLE conversations ADD COLUMN last_message_at TIMESTAMP NULL`
    );

    // ---------- company_members ----------
    console.log('\n[company_members]');
    await addColumn('company_members', 'joined_at',
      `ALTER TABLE company_members ADD COLUMN joined_at TIMESTAMP NULL`
    );

    // ---------- cover_letters ----------
    console.log('\n[cover_letters]');
    await addIndex('cover_letters', 'idx_cover_letters_candidate_job',
      `ALTER TABLE cover_letters ADD CONSTRAINT idx_cover_letters_candidate_job UNIQUE (candidate_id, job_id)`
    );

    // ---------- usage_logs ----------
    console.log('\n[usage_logs]');
    await addColumn('usage_logs', 'input_tokens',
      `ALTER TABLE usage_logs ADD COLUMN input_tokens INT NULL`
    );
    await addColumn('usage_logs', 'output_tokens',
      `ALTER TABLE usage_logs ADD COLUMN output_tokens INT NULL`
    );
    await addColumn('usage_logs', 'tts_characters',
      `ALTER TABLE usage_logs ADD COLUMN tts_characters INT NULL`
    );
    await addColumn('usage_logs', 'status',
      `ALTER TABLE usage_logs ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'success'`
    );
    await addColumn('usage_logs', 'error_type',
      `ALTER TABLE usage_logs ADD COLUMN error_type VARCHAR(32) NULL`
    );

    } // end if (!isSqlite)

    // SQLite: add application CV fields if missing
    if (isSqlite) {
      await addColumn('applications', 'cv_type', `ALTER TABLE applications ADD COLUMN cv_type TEXT DEFAULT 'original'`);
      await addColumn('applications', 'submitted_cv_text', `ALTER TABLE applications ADD COLUMN submitted_cv_text TEXT`);
      await addColumn('usage_logs', 'input_tokens', `ALTER TABLE usage_logs ADD COLUMN input_tokens INTEGER NULL`);
      await addColumn('usage_logs', 'output_tokens', `ALTER TABLE usage_logs ADD COLUMN output_tokens INTEGER NULL`);
      await addColumn('usage_logs', 'tts_characters', `ALTER TABLE usage_logs ADD COLUMN tts_characters INTEGER NULL`);
      await addColumn('usage_logs', 'status', `ALTER TABLE usage_logs ADD COLUMN status TEXT NOT NULL DEFAULT 'success'`);
      await addColumn('usage_logs', 'error_type', `ALTER TABLE usage_logs ADD COLUMN error_type TEXT NULL`);
    }

    // ===================================================================
    // DONE
    // ===================================================================
    console.log('\n✅ All tables created/verified successfully!');
    console.log('\nTables (' + models.length + '):');
    for (const { table } of models) {
      console.log(`  - ${table}`);
    }

    await sequelize.close();
    process.exit(0);
  } catch (error: any) {
    console.error('❌ Migration failed:', error.message);
    if (error.parent) {
      console.error('Database error:', error.parent.message);
    }
    console.error('Full error:', error);
    process.exit(1);
  }
}

migrate();
