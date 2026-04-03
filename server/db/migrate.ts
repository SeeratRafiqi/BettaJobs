import sequelize from './config.js';
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

async function syncDatabase() {
  try {
    console.log('Connecting to PostgreSQL...');
    await sequelize.authenticate();
    console.log('Connected to PostgreSQL');

    const force = process.env.DB_FORCE_SYNC === 'true';
    const alter = process.env.DB_ALTER_SYNC !== 'false'; // default true

    console.log(`Sync started (force=${force}, alter=${alter})`);

    for (const { name, model } of models) {
      await model.sync({ force, alter: force ? false : alter });
      console.log(`Synced: ${name}`);
    }

    console.log('All models synced successfully');

    const [rows] = await sequelize.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    console.log('Tables in public schema:');
    for (const row of rows as Array<{ table_name: string }>) {
      console.log(`- ${row.table_name}`);
    }

    await sequelize.close();
    process.exit(0);
  } catch (error: any) {
    console.error('Database sync failed:', error.message);

    if (error?.parent?.message) {
      console.error('Postgres error:', error.parent.message);
    }

    if (
      error?.message?.includes('permission denied') ||
      error?.parent?.message?.includes('permission denied')
    ) {
      console.error(`
Your Postgres user likely cannot create tables in schema public.

Run this as a superuser or DB owner:
GRANT USAGE ON SCHEMA public TO YOUR_USER;
GRANT CREATE ON SCHEMA public TO YOUR_USER;
      `);
    }

    process.exit(1);
  }
}

syncDatabase();