import { Response } from 'express';
import { randomUUID } from 'crypto';
import { Op, DataTypes } from 'sequelize';
import sequelize from '../db/config.js';
import {
  Application,
  Candidate,
  CvFile,
  Job,
  VoiceInterviewSession,
} from '../db/models/index.js';
import type { AuthRequest } from '../middleware/auth.js';
import { qwenService, type InterviewState } from '../services/qwen.js';
import { pdfParserService } from '../services/pdfParser.js';
import { synthesizeSpeech, isAlibabaSpeechAvailable } from '../services/alibabaSpeech.js';
import { notifyVoiceInterviewAssigned } from '../services/alibabaNotification.js';
import { logUsage, logUsageFailure, inferErrorType } from '../services/usageService.js';

const VOICE_INTERVIEW_EXPIRY_HOURS = 72;
/** Once started, candidate must complete within this many minutes. */
const VOICE_INTERVIEW_DURATION_MINUTES = 10;
/** Number of "turns" for intro (greeting, small talk, context, ready check). Used before script questions. */
const INTRO_TURNS = 4;

/** Build Q&A list from conductor conversationHistory when session.questions/answers are empty. Pairs assistant message → next user message as one Q&A. */
function buildQaFromConversationHistory(conductorStateRaw: string | null | undefined): { question: string; answer: string; answeredAt: string | null }[] {
  const out: { question: string; answer: string; answeredAt: string | null }[] = [];
  if (!conductorStateRaw || typeof conductorStateRaw !== 'string') return out;
  let state: { conversationHistory?: { role: string; content: string }[] };
  try {
    state = JSON.parse(conductorStateRaw);
  } catch {
    return out;
  }
  const history = state.conversationHistory;
  if (!Array.isArray(history)) return out;
  let lastAssistant = '';
  for (const msg of history) {
    const role = (msg?.role || '').toLowerCase();
    const content = (msg?.content || '').trim();
    if (role === 'assistant') {
      lastAssistant = content;
    } else if (role === 'user' && lastAssistant) {
      out.push({ question: lastAssistant, answer: content, answeredAt: null });
      lastAssistant = '';
    }
  }
  return out;
}

/** Same substantive filters as filterToInterviewQa, for paired Q&A from conductor conversationHistory (correct turn order). */
function filterInterviewQaPairsFromConductorState(conductorStateRaw: string | null | undefined): { questionTexts: string[]; answerTexts: string[] } {
  const pairs = buildQaFromConversationHistory(conductorStateRaw);
  const questionTexts: string[] = [];
  const answerTexts: string[] = [];
  const smallTalkPattern = /^(no worries|take your time|how are you|hi\b|hello\b|thanks|thank you|great to have you|glad you could|sure\b|ok\b|okay\b|sounds good|let'?s begin|let'?s start|are you ready|any questions before we begin|perfect\b|alright\b)/i;
  for (const p of pairs) {
    const q = (p.question || '').trim();
    const a = (p.answer || '').trim();
    if (q.length < 10) continue;
    if (smallTalkPattern.test(q)) continue;
    questionTexts.push(q);
    answerTexts.push(a);
  }
  return { questionTexts, answerTexts };
}

/** Script questions from conductor state (recruiter-allocated technical count). */
function parseConductorScriptQuestions(conductorStateRaw: string | null | undefined): string[] {
  if (!conductorStateRaw || typeof conductorStateRaw !== 'string') return [];
  try {
    const state = JSON.parse(conductorStateRaw) as { questions?: unknown };
    if (!Array.isArray(state.questions)) return [];
    return state.questions.map((s) => String(s ?? '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Summary/outcome only: pair each recruiter-allocated script line (index i) with the stored answer for questionIndex i.
 * Ignores intro/small-talk in history; transcript should still use buildQaFromConversationHistory.
 */
function buildTechnicalQaForSummary(
  conductorStateRaw: string | null | undefined,
  answersData: string | { questionIndex: number; answerText: string }[] | null | undefined
): { questionTexts: string[]; answerTexts: string[] } {
  const script = parseConductorScriptQuestions(conductorStateRaw);
  if (script.length === 0) return { questionTexts: [], answerTexts: [] };

  let answers: { questionIndex: number; answerText: string }[] = [];
  if (Array.isArray(answersData)) {
    answers = answersData;
  } else if (typeof answersData === 'string') {
    try {
      answers = JSON.parse(answersData || '[]');
    } catch {
      return { questionTexts: [], answerTexts: [] };
    }
  } else {
    return { questionTexts: [], answerTexts: [] };
  }

  const byIndex = new Map<number, string>();
  for (const a of answers) {
    if (a && typeof a.questionIndex === 'number') {
      byIndex.set(a.questionIndex, String(a.answerText ?? '').trim());
    }
  }

  const questionTexts: string[] = [];
  const answerTexts: string[] = [];
  for (let i = 0; i < script.length; i++) {
    questionTexts.push(script[i]);
    answerTexts.push(byIndex.get(i) ?? '');
  }
  return { questionTexts, answerTexts };
}

/** Number of technical questions allocated for this session (script length), or derived from max_questions − intro turns. */
function allocatedInterviewQuestionCount(session: { conductor_state?: string | null; max_questions?: number | null }): number {
  const scriptLen = parseConductorScriptQuestions(session.conductor_state ?? undefined).length;
  if (scriptLen > 0) return scriptLen;
  const max = session.max_questions ?? 0;
  return Math.max(0, max - INTRO_TURNS);
}

function hasSubstantiveAnswerText(text: string): boolean {
  const t = (text || '').trim();
  if (!t || t.length < 3) return false;
  if (isSilenceAnswer(t) || isSilenceCheckMarker(t)) return false;
  const lower = t.toLowerCase();
  if (lower === '(no answer provided)' || lower === '(no answer)' || lower === '(no response)') return false;
  return true;
}

/** Inputs for generateVoiceInterviewOutcome: prefer script+indexed answers; fall back if conductor data missing. */
function getSummaryQuestionAnswerTexts(
  conductorStateRaw: string | null | undefined,
  answersData: string | { questionIndex: number; answerText: string }[],
  questions: { question: string; order: number }[],
  qaTranscriptFallback: { question: string; answer: string }[]
): { questionTexts: string[]; answerTexts: string[] } {
  const technical = buildTechnicalQaForSummary(conductorStateRaw, answersData);
  if (technical.questionTexts.length > 0 && technical.answerTexts.some(hasSubstantiveAnswerText)) return technical;

  const fromHist = conductorStateRaw ? filterInterviewQaPairsFromConductorState(conductorStateRaw) : { questionTexts: [] as string[], answerTexts: [] as string[] };
  if (fromHist.questionTexts.length > 0) return fromHist;

  const legacy = filterToInterviewQa(
    questions,
    Array.isArray(answersData) ? (answersData as { questionIndex: number; answerText: string; answeredAt: string }[]) : []
  );
  if (legacy.questionTexts.length > 0) return legacy;

  return {
    questionTexts: qaTranscriptFallback.map((x) => (x.question || '').trim()).filter(Boolean),
    answerTexts: qaTranscriptFallback.map((x) => (x.answer || '').trim()),
  };
}

/** Whether we have enough transcript data to build an AI summary. */
function hasSummarySourceContent(
  questionTexts: string[],
  answerTexts: string[],
  qa: { question: string; answer: string }[],
  substantiveAnswerCount: number
): boolean {
  if (questionTexts.length > 0) return true;
  if (answerTexts.some((a) => a.trim().length > 0)) return true;
  if (qa.some((p) => (p.question || '').trim().length > 0 || (p.answer || '').trim().length > 0)) return true;
  return substantiveAnswerCount > 0;
}

/** Resolve Q/A inputs for outcome generation, falling back to full conversation transcript. */
function resolveOutcomeQaInputs(
  questionTexts: string[],
  answerTexts: string[],
  qa: { question: string; answer: string }[]
): { questionsForOutcome: string[]; answersForOutcome: string[] } {
  if (questionTexts.length > 0 && answerTexts.some(hasSubstantiveAnswerText)) {
    return { questionsForOutcome: questionTexts, answersForOutcome: answerTexts };
  }
  const questionsForOutcome = qa.map((x) => (x.question || '').trim()).filter(Boolean);
  const answersForOutcome = qa.map((x) => (x.answer || '').trim());
  return { questionsForOutcome, answersForOutcome };
}

/** Minimum substantive answers before generating a partial summary for incomplete sessions. */
const MIN_ANSWERS_FOR_MIDWAY_SUMMARY = 2;

const CANDIDATE_MIDWAY_PREFIX =
  'The interview ended before every question was covered. The feedback below is based on the questions you answered.\n\n';
const RECRUITER_MIDWAY_PREFIX =
  'Interview ended before all allocated questions were covered.\n\n';

/** Legacy prefixes / wording saved before copy was fixed — strip on read for completed sessions. */
const LEFT_EARLY_CANDIDATE_RE = /^You left the interview before all questions were completed[^\n]*\n\n/i;
const LEFT_EARLY_RECRUITER_RE = /^Interview incomplete: the candidate left before all allocated questions were answered\.\n\n/i;

function outcomeHasLeftEarlyWording(text: string | null | undefined): boolean {
  if (!text?.trim()) return false;
  return /left the interview before all questions|left before all allocated questions were answered/i.test(text);
}

/** Generic placeholder saved when summary ran without real transcript pairing. */
function isGenericFallbackOutcome(text: string | null | undefined): boolean {
  if (!text?.trim()) return false;
  return /did not provide substantive answers|your answers in this interview were limited/i.test(text);
}

function sanitizeInterviewOutcomeText(
  status: string,
  text: string | null | undefined,
  naturallyFinished: boolean
): string | null {
  if (!text?.trim()) return text ?? null;
  const endedNormally = isReportableEndedSession(status) || naturallyFinished;
  if (!endedNormally) return text;
  let result = text;
  if (result.startsWith(CANDIDATE_MIDWAY_PREFIX)) result = result.slice(CANDIDATE_MIDWAY_PREFIX.length);
  if (result.startsWith(RECRUITER_MIDWAY_PREFIX)) result = result.slice(RECRUITER_MIDWAY_PREFIX.length);
  result = result.replace(LEFT_EARLY_CANDIDATE_RE, '');
  result = result.replace(LEFT_EARLY_RECRUITER_RE, '');
  return result.trim() || text;
}

function parseConductorPhase(conductorStateRaw: string | null | undefined): string | null {
  if (!conductorStateRaw) return null;
  try {
    const state = JSON.parse(conductorStateRaw);
    return typeof state?.phase === 'string' ? state.phase : null;
  } catch {
    return null;
  }
}

/** True when all allocated questions were answered or the conductor reached closing — even if status is still in_progress (e.g. refresh before final persist). */
function isNaturallyFinishedInterview(
  session: { conductor_state?: string | null; max_questions?: number | null; status: string },
  answers: { questionIndex: number; answerText: string }[]
): boolean {
  if (session.status === 'completed') return true;
  if (parseConductorPhase(session.conductor_state) === 'closing') return true;
  const allocated = allocatedInterviewQuestionCount(session);
  const substantive = countSubstantiveInterviewAnswers(answers);
  return allocated > 0 && substantive >= allocated;
}

/** True only when the candidate abandoned an active session (not a normal or timed end). */
function isAbandonedInProgressSession(
  session: { status: string },
  naturallyFinished: boolean
): boolean {
  return session.status === 'in_progress' && !naturallyFinished;
}

/** Sessions where a full (non-midway) summary should be generated on report load. */
function isReportableEndedSession(status: string): boolean {
  return status === 'completed' || status === 'expired';
}

/** Align DB status with timer / expiry before report generation (mirrors getSession). */
async function syncVoiceInterviewEndedStatus(
  session: VoiceInterviewSession & { duration_minutes?: number | null }
): Promise<void> {
  const now = new Date();
  const expired = new Date(session.expires_at) < now;
  const startedAt = session.started_at ? new Date(session.started_at) : null;
  const durationMins = session.duration_minutes ?? VOICE_INTERVIEW_DURATION_MINUTES;
  const durationMs = durationMins * 60 * 1000;
  const timeLimitExceeded =
    session.status === 'in_progress' &&
    startedAt &&
    now.getTime() - startedAt.getTime() > durationMs;
  if (timeLimitExceeded || (expired && session.status !== 'completed')) {
    await session.update({ status: 'expired', updated_at: new Date() });
    session.status = 'expired';
  }
}

function countSubstantiveAnswersFromQa(qa: { answer: string }[]): number {
  return qa.filter((p) => {
    const t = (p.answer || '').trim();
    if (!t || t.length < 3) return false;
    if (isSilenceAnswer(t) || isSilenceCheckMarker(t)) return false;
    const lower = t.toLowerCase();
    if (lower === '(no answer provided)' || lower === '(no answer)' || lower === '(no response)') return false;
    return true;
  }).length;
}

function countSubstantiveInterviewAnswers(answers: { questionIndex: number; answerText: string }[]): number {
  return answers.filter((a) => {
    const t = (a.answerText || '').trim();
    if (!t || t.length < 3) return false;
    if (isSilenceAnswer(t) || isSilenceCheckMarker(t)) return false;
    const lower = t.toLowerCase();
    if (lower === '(no answer provided)' || lower === '(no answer)' || lower === '(no response)') return false;
    return true;
  }).length;
}

/** Filter to only substantive interview Q&A; exclude greeting and small talk. Keeps questions with length >= 10 so summary can be generated from real Q&A. */
function filterToInterviewQa(
  questions: { question: string; order: number }[],
  answers: { questionIndex: number; answerText: string; answeredAt: string }[]
): { questionTexts: string[]; answerTexts: string[] } {
  const questionTexts: string[] = [];
  const answerTexts: string[] = [];
  const smallTalkPattern = /^(no worries|take your time|how are you|hi\b|hello\b|thanks|thank you|great to have you|glad you could|sure\b|ok\b|okay\b|sounds good|let'?s begin|let'?s start|are you ready|any questions before we begin|perfect\b|alright\b)/i;
  for (let i = 0; i < questions.length; i++) {
    const q = (questions[i]?.question || '').trim();
    const a = (answers[i]?.answerText || '').trim();
    if (q.length < 10) continue;
    if (smallTalkPattern.test(q)) continue;
    questionTexts.push(q);
    answerTexts.push(a);
  }
  return { questionTexts, answerTexts };
}

/** True if the answer represents silence / no response (for "Are you there?" reply). */
function isSilenceAnswer(text: string): boolean {
  const t = (text || '').trim().toLowerCase();
  if (!t) return true;
  if (/^\(no response\)$|^\(no answer provided\)$|^\[silence\]$/.test(t)) return true;
  return false;
}

/** True if text is a silence-check marker from the client (8s or 15s no speech). */
function isSilenceCheckMarker(text: string): boolean {
  const t = (text || '').trim().toLowerCase();
  return /^\(silence 8s\)$|^\(silence 15s\)$/.test(t);
}

/** Localized "Just checking — can you hear me?" for 8s silence. */
function getSilenceCheck8sMessage(preferredLanguage: string): string {
  const lang = (preferredLanguage || 'en').split('-')[0];
  const messages: Record<string, string> = {
    en: 'Just checking — can you hear me?',
    ar: 'فقط أتأكد — هل تسمعني؟',
    es: 'Solo comprobando — ¿me oyes?',
    fr: 'Juste pour vérifier — vous m\'entendez ?',
    de: 'Nur zur Kontrolle — hören Sie mich?',
    zh: '只是确认一下——你能听到我吗？',
    ja: '確認です——聞こえていますか？',
    hi: 'बस जाँच — क्या आप मुझे सुन सकते हैं?',
    pt: 'Só verificando — consegue me ouvir?',
    ko: '확인해요 — 들리시나요?',
  };
  return messages[lang] ?? messages.en;
}

/** Localized "Are you still there?" for 15s silence. */
function getSilenceCheck15sMessage(preferredLanguage: string): string {
  const lang = (preferredLanguage || 'en').split('-')[0];
  const messages: Record<string, string> = {
    en: 'Are you still there?',
    ar: 'هل ما زلت هناك؟',
    es: '¿Sigues ahí?',
    fr: 'Êtes-vous toujours là ?',
    de: 'Sind Sie noch da?',
    zh: '你还在吗？',
    ja: 'まだいますか？',
    hi: 'क्या आप अभी भी वहाँ हैं?',
    pt: 'Ainda está aí?',
    ko: '아직 계세요?',
  };
  return messages[lang] ?? messages.en;
}

/** Localized "Are you there?" for real-time silence check. */
function getAreYouThereMessage(preferredLanguage: string): string {
  const lang = (preferredLanguage || 'en').split('-')[0];
  const messages: Record<string, string> = {
    en: 'Are you there? If you can hear me, please say something or type in the chat.',
    ar: 'هل أنت هنا؟ إذا كنت تسمعني، يرجى قول شيء أو الكتابة.',
    es: '¿Estás ahí? Si me escuchas, por favor di algo o escribe en el chat.',
    fr: 'Êtes-vous là ? Si vous m\'entendez, dites quelque chose ou écrivez dans le chat.',
    de: 'Sind Sie da? Wenn Sie mich hören, sagen Sie bitte etwas oder tippen Sie.',
    zh: '你还在吗？如果你能听到我，请说点什么或在聊天中打字。',
    ja: '聞こえますか？聞こえたら何か話すかチャットに打ってください。',
    hi: 'क्या आप वहाँ हैं? अगर सुन सकते हैं तो कुछ बोलें या चैट में टाइप करें।',
    pt: 'Você está aí? Se me ouve, por favor diga algo ou digite no chat.',
    ko: '계세요? 들리시면 말씀하시거나 채팅에 입력해 주세요.',
  };
  return messages[lang] ?? messages.en;
}

/** True if the candidate is reporting mic/tech issues (offer reschedule). */
function isTechnicalIssue(text: string): boolean {
  const t = (text || '').trim().toLowerCase();
  const phrases = [
    'mic not working', 'microphone not working', 'can\'t hear', 'cannot hear',
    'no sound', 'audio not working', 'mic is not', 'microphone is not',
    'can\'t use my mic', 'cannot use my mic', 'mic doesn\'t work', 'audio doesn\'t',
    'reschedule', 'technical issue', 'technical problem', 'connection problem',
    'my mic', 'my microphone', 'audio problem', 'sound problem', 'not working',
  ];
  return phrases.some((p) => t.includes(p));
}

/** True if the candidate accepted reschedule (end call). */
function userConfirmedReschedule(text: string): boolean {
  const t = (text || '').trim().toLowerCase();
  const yesPhrases = ['yes', 'yeah', 'yep', 'sure', 'please', 'ok', 'okay', 'reschedule', 'confirm', 'agreed', 'fine'];
  return yesPhrases.some((p) => t.includes(p)) || /^y(eah?|es)?$/i.test(t) || /^ok(ay)?$/i.test(t);
}

/** Localized reschedule offer. */
function getRescheduleOfferMessage(preferredLanguage: string): string {
  const lang = (preferredLanguage || 'en').split('-')[0];
  const messages: Record<string, string> = {
    en: 'It sounds like we\'re having technical issues. Would you like to reschedule? Please say yes to confirm and we\'ll end the call.',
    ar: 'يبدو أننا نواجه مشاكل تقنية. هل ترغب في إعادة الجدولة؟ قل نعم للتأكيد وسننهي المكالمة.',
    es: 'Parece que hay problemas técnicos. ¿Le gustaría reprogramar? Diga sí para confirmar y terminaremos la llamada.',
    fr: 'Il semble que nous ayons des problèmes techniques. Souhaitez-vous reporter ? Dites oui pour confirmer et nous terminerons l\'appel.',
    de: 'Es klingt nach technischen Problemen. Möchten Sie neu planen? Bitte sagen Sie Ja zur Bestätigung, dann beenden wir den Anruf.',
    zh: '听起来我们遇到了技术问题。您想改期吗？请说“是”确认，我们将结束通话。',
    ja: '技術的な問題が発生しているようです。再スケジュールしますか？「はい」と言っていただければ通話を終了します。',
    hi: 'लगता है तकनीकी समस्या हो रही है। क्या आप पुनर्निर्धारण करना चाहेंगे? पुष्टि के लिए हाँ कहें और हम कॉल समाप्त कर देंगे।',
    pt: 'Parece que estamos com problemas técnicos. Gostaria de reagendar? Diga sim para confirmar e encerraremos a chamada.',
    ko: '기술적 문제가 있는 것 같습니다. 일정을 변경하시겠습니까? 확인하려면 예라고 하시면 통화를 종료하겠습니다.',
  };
  return messages[lang] ?? messages.en;
}

let outcomeColumnEnsured = false;
async function ensureOutcomeColumn(): Promise<void> {
  if (outcomeColumnEnsured) return;
  try {
    const dialect = sequelize.getDialect();
    if (dialect === 'sqlite') {
      await sequelize.getQueryInterface().addColumn('voice_interview_sessions', 'outcome', {
        type: DataTypes.TEXT,
        allowNull: true,
      });
    } else {
      await sequelize.query('ALTER TABLE voice_interview_sessions ADD COLUMN IF NOT EXISTS outcome TEXT NULL');
    }
  } catch (e: any) {
    const msg = e?.message ?? '';
    if (!msg.includes('duplicate') && !msg.includes('already exists')) {
      console.warn('[VoiceInterview] ensure outcome column:', msg.substring(0, 100));
    }
  }
  outcomeColumnEnsured = true;
}

let candidateOutcomeColumnEnsured = false;
async function ensureCandidateOutcomeColumn(): Promise<void> {
  if (candidateOutcomeColumnEnsured) return;
  try {
    const dialect = sequelize.getDialect();
    if (dialect === 'sqlite') {
      await sequelize.getQueryInterface().addColumn('voice_interview_sessions', 'candidate_outcome', {
        type: DataTypes.TEXT,
        allowNull: true,
      });
    } else {
      await sequelize.query('ALTER TABLE voice_interview_sessions ADD COLUMN IF NOT EXISTS candidate_outcome TEXT NULL');
    }
  } catch (e: any) {
    const msg = e?.message ?? '';
    if (!msg.includes('duplicate') && !msg.includes('already exists')) {
      console.warn('[VoiceInterview] ensure candidate_outcome column:', msg.substring(0, 100));
    }
  }
  candidateOutcomeColumnEnsured = true;
}

let durationMinutesColumnEnsured = false;
async function ensureDurationMinutesColumn(): Promise<void> {
  if (durationMinutesColumnEnsured) return;
  try {
    const dialect = sequelize.getDialect();
    if (dialect === 'sqlite') {
      await sequelize.getQueryInterface().addColumn('voice_interview_sessions', 'duration_minutes', {
        type: DataTypes.INTEGER,
        allowNull: true,
      });
    } else {
      await sequelize.query('ALTER TABLE voice_interview_sessions ADD COLUMN IF NOT EXISTS duration_minutes INT NULL');
    }
  } catch (e: any) {
    const msg = e?.message ?? '';
    if (!msg.includes('duplicate') && !msg.includes('already exists')) {
      console.warn('[VoiceInterview] ensure duration_minutes column:', msg.substring(0, 100));
    }
  }
  durationMinutesColumnEnsured = true;
}

let conductorStateColumnEnsured = false;
async function ensureConductorStateColumn(): Promise<void> {
  if (conductorStateColumnEnsured) return;
  try {
    const dialect = sequelize.getDialect();
    if (dialect === 'sqlite') {
      await sequelize.getQueryInterface().addColumn('voice_interview_sessions', 'conductor_state', {
        type: DataTypes.TEXT,
        allowNull: true,
      });
    } else {
      await sequelize.query('ALTER TABLE voice_interview_sessions ADD COLUMN IF NOT EXISTS conductor_state TEXT NULL');
    }
  } catch (e: any) {
    const msg = e?.message ?? '';
    if (!msg.includes('duplicate') && !msg.includes('already exists')) {
      console.warn('[VoiceInterview] ensure conductor_state column:', msg.substring(0, 100));
    }
  }
  conductorStateColumnEnsured = true;
}

/** Approximate minutes per Q&A (candidate answer + AI reply + thinking). */
const MINUTES_PER_QUESTION = 2;
/** Min/max interview questions (excluding intro). */
const MIN_INTERVIEW_QUESTIONS = 3;
const MAX_INTERVIEW_QUESTIONS = 12;

/** Compute how many total turns (intro + questions) fit in durationMinutes so the AI asks the right number of questions. */
function maxTurnsFromDuration(durationMinutes: number): number {
  const minutesForIntro = 2;
  const minutesForQa = Math.max(0, durationMinutes - minutesForIntro);
  const questionCount = Math.min(
    MAX_INTERVIEW_QUESTIONS,
    Math.max(MIN_INTERVIEW_QUESTIONS, Math.floor(minutesForQa / MINUTES_PER_QUESTION))
  );
  return INTRO_TURNS + questionCount;
}

type JobWithCompany = Job & { company_id: string };

async function assertCompanyAccess(req: AuthRequest, companyId: string) {
  if (!req.user) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const { CompanyProfile } = await import('../db/models/index.js');
  const company = await CompanyProfile.findOne({ where: { id: companyId, user_id: req.user.id } });
  if (!company) throw Object.assign(new Error('Forbidden'), { status: 403 });
  return company;
}

/** Avoid blocking interview start on slow/large PDFs (e.g. slow disk on deploy). */
const CV_TEXT_FOR_INTERVIEW_MS = 12_000;

async function getCandidateCvText(candidateId: string): Promise<string> {
  const cvFile = await CvFile.findOne({
    where: { candidate_id: candidateId },
    order: [['uploaded_at', 'DESC']],
  });
  if (!cvFile?.file_path) return '';
  const parse = pdfParserService.extractText(cvFile.file_path);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('cv_parse_timeout')), CV_TEXT_FOR_INTERVIEW_MS)
  );
  try {
    return await Promise.race([parse, timeout]);
  } catch {
    return '';
  }
}

export const voiceInterviewController = {
  async assign(req: AuthRequest, res: Response) {
    try {
      await ensureDurationMinutesColumn();
      await ensureConductorStateColumn();
      const { applicationId, durationMinutes, interviewQuestionCount } = req.body || {};
      if (!applicationId) return res.status(400).json({ message: 'applicationId is required' });
      const duration = durationMinutes != null ? Math.min(60, Math.max(5, Number(durationMinutes))) : 10;

      const application = await Application.findByPk(applicationId, {
        include: [{ model: Job, as: 'job' }],
      }) as (Application & { job?: JobWithCompany }) | null;
      if (!application) return res.status(404).json({ message: 'Application not found' });
      const job = application.job;
      if (!job) return res.status(404).json({ message: 'Job not found' });

      await assertCompanyAccess(req, job.company_id);

      const allowedStatuses = ['applied', 'screening', 'interview'];
      if (!allowedStatuses.includes(application.status)) {
        return res.status(400).json({
          message: 'Voice interview can only be assigned when application is applied, in screening, or in interview stage.',
        });
      }

      const existing = await VoiceInterviewSession.findOne({
        where: { application_id: applicationId, status: { [Op.in]: ['assigned', 'in_progress'] } },
      });
      if (existing) {
        return res.status(409).json({ message: 'A voice interview is already assigned for this application.' });
      }

      /** Recruiter-chosen number of technical/script questions (optional). Intro turns are added server-side. */
      let maxTurns: number;
      if (interviewQuestionCount != null && interviewQuestionCount !== '') {
        const n = Number(interviewQuestionCount);
        if (!Number.isFinite(n)) {
          return res.status(400).json({ message: 'interviewQuestionCount must be a number' });
        }
        const q = Math.min(
          MAX_INTERVIEW_QUESTIONS,
          Math.max(MIN_INTERVIEW_QUESTIONS, Math.floor(n))
        );
        maxTurns = INTRO_TURNS + q;
      } else {
        maxTurns = maxTurnsFromDuration(duration);
      }
      const expiresAt = new Date(Date.now() + VOICE_INTERVIEW_EXPIRY_HOURS * 60 * 60 * 1000);
      const session = await VoiceInterviewSession.create({
        id: randomUUID(),
        application_id: applicationId,
        candidate_id: application.candidate_id,
        job_id: application.job_id,
        status: 'assigned',
        questions: '[]',
        answers: '[]',
        current_question_index: 0,
        max_questions: maxTurns,
        duration_minutes: duration,
        expires_at: expiresAt,
      });

      try {
        const candidate = await Candidate.findByPk(application.candidate_id, { attributes: ['email', 'name'] });
        const jobTitle = job?.title ?? 'the role';
        if (candidate?.email) {
          await notifyVoiceInterviewAssigned({
            toEmail: (candidate as any).email,
            candidateName: (candidate as any).name ?? 'Candidate',
            jobTitle,
            sessionId: session.id,
            expiresAt,
          });
        }
      } catch (_) {
        /* ignore notification failure */
      }

      return res.status(201).json({
        message: 'Voice interview assigned',
        session: {
          id: session.id,
          applicationId: session.application_id,
          jobId: session.job_id,
          status: session.status,
          maxQuestions: session.max_questions,
          /** Role/technical questions (excludes intro turns). Same as `maxQuestions - INTRO_TURNS` at assign time. */
          allocatedInterviewQuestions: Math.max(0, maxTurns - INTRO_TURNS),
          expiresAt: session.expires_at,
        },
      });
    } catch (e: any) {
      console.error('[VoiceInterview] assign failed:', e?.message);
      const status = (e as any)?.status ?? 500;
      return res.status(status).json({ message: e?.message ?? 'Failed to assign voice interview' });
    }
  },

  /**
   * Create a test voice interview session so you can open the interview without going through job/apply/assign.
   * Uses the first available job and creates an application if needed. For testing only.
   */
  async createTestSession(req: AuthRequest, res: Response) {
    try {
      await ensureDurationMinutesColumn();
      await ensureConductorStateColumn();
      if (!req.user) return res.status(401).json({ message: 'Authentication required' });
      const candidate = await Candidate.findOne({ where: { user_id: req.user.id } });
      if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

      const duration = 10;
      const maxTurns = maxTurnsFromDuration(duration);
      const expiresAt = new Date(Date.now() + VOICE_INTERVIEW_EXPIRY_HOURS * 60 * 60 * 1000);

      const job = await Job.findOne({
        where: { status: 'published' },
        order: [['created_at', 'DESC']],
        limit: 1,
      });
      if (!job) return res.status(400).json({ message: 'No job found. Create at least one published job first.' });

      let application = await Application.findOne({
        where: { candidate_id: candidate.id, job_id: job.id },
      });
      if (!application) {
        application = await Application.create({
          candidate_id: candidate.id,
          job_id: job.id,
          status: 'applied',
        } as any);
      }

      const existing = await VoiceInterviewSession.findOne({
        where: { application_id: application.id, status: { [Op.in]: ['assigned', 'in_progress'] } },
      });
      if (existing) {
        return res.status(200).json({
          message: 'Test session already exists',
          sessionId: existing.id,
          url: `/candidate/voice-interviews/${existing.id}`,
        });
      }

      const session = await VoiceInterviewSession.create({
        id: randomUUID(),
        application_id: application.id,
        candidate_id: candidate.id,
        job_id: job.id,
        status: 'assigned',
        questions: '[]',
        answers: '[]',
        current_question_index: 0,
        max_questions: maxTurns,
        duration_minutes: duration,
        expires_at: expiresAt,
      });

      return res.status(201).json({
        message: 'Test voice interview session created',
        sessionId: session.id,
        url: `/candidate/voice-interviews/${session.id}`,
      });
    } catch (e: any) {
      console.error('[VoiceInterview] createTestSession failed:', e?.message);
      return res.status(500).json({ message: e?.message ?? 'Failed to create test session' });
    }
  },

  async getForApplication(req: AuthRequest, res: Response) {
    try {
      if (!req.user) return res.status(401).json({ message: 'Authentication required' });
      const candidate = await Candidate.findOne({ where: { user_id: req.user.id } });
      if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

      const { applicationId } = req.params;
      const application = await Application.findOne({
        where: { id: applicationId, candidate_id: candidate.id },
        attributes: ['id'],
      });
      if (!application) return res.status(404).json({ message: 'Application not found' });

      const session = await VoiceInterviewSession.findOne({
        where: { application_id: applicationId },
        include: [{ model: Job, as: 'job', attributes: ['id', 'title'], required: false }],
      });
      if (!session) return res.json({ session: null });

      const now = new Date();
      const expired = new Date(session.expires_at) < now;
      const status = expired && session.status !== 'completed' ? 'expired' : session.status;

      return res.json({
        session: {
          id: session.id,
          jobId: session.job_id,
          jobTitle: (session as any).job?.title ?? 'Job',
          status,
          currentQuestionIndex: session.current_question_index,
          maxQuestions: session.max_questions,
          expiresAt: session.expires_at,
          completedAt: session.completed_at,
        },
      });
    } catch (e: any) {
      console.error('[VoiceInterview] getForApplication failed:', e?.message);
      return res.status(500).json({ message: e?.message ?? 'Failed to load session' });
    }
  },

  async getMySessions(req: AuthRequest, res: Response) {
    try {
      await ensureOutcomeColumn();
      if (!req.user) return res.status(401).json({ message: 'Authentication required' });
      const candidate = await Candidate.findOne({ where: { user_id: req.user.id } });
      if (!candidate) return res.json({ sessions: [] });

      const now = new Date();
      // Find all sessions for this candidate (by candidate_id only so it works as soon as recruiter assigns)
      const sessions = await VoiceInterviewSession.findAll({
        where: { candidate_id: candidate.id },
        attributes: ['id', 'job_id', 'application_id', 'status', 'current_question_index', 'max_questions', 'expires_at', 'completed_at'],
        order: [['created_at', 'DESC']],
      });

      const jobIds = [...new Set(sessions.map((s) => s.job_id).filter(Boolean))] as string[];
      const jobs = jobIds.length > 0 ? await Job.findAll({ where: { id: { [Op.in]: jobIds } }, attributes: ['id', 'title'] }) : [];
      const jobMap = new Map(jobs.map((j) => [j.id, j.title]));

      const list = sessions.map((s) => {
        const expired = new Date(s.expires_at) < now;
        return {
          id: s.id,
          jobId: s.job_id,
          jobTitle: jobMap.get(s.job_id) ?? 'Job',
          status: expired && s.status !== 'completed' ? 'expired' : s.status,
          currentQuestionIndex: s.current_question_index,
          maxQuestions: s.max_questions,
          expiresAt: s.expires_at,
          completedAt: s.completed_at,
        };
      });

      return res.json({ sessions: list });
    } catch (e: any) {
      console.error('[VoiceInterview] getMySessions failed:', e?.message);
      return res.status(500).json({ message: e?.message ?? 'Failed to load sessions' });
    }
  },

  async getSession(req: AuthRequest, res: Response) {
    try {
      if (!req.user) return res.status(401).json({ message: 'Authentication required' });
      const candidate = await Candidate.findOne({ where: { user_id: req.user.id } });
      if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

      const { id } = req.params;
      const myAppIds = (await Application.findAll({ where: { candidate_id: candidate.id }, attributes: ['id'] })).map((a) => a.id);
      const sessionWhere =
        myAppIds.length > 0
          ? { id, [Op.or]: [{ application_id: { [Op.in]: myAppIds } }, { candidate_id: candidate.id }] }
          : { id, candidate_id: candidate.id };
      const session = await VoiceInterviewSession.findOne({
        where: sessionWhere,
        include: [{ model: Job, as: 'job', attributes: ['id', 'title'], required: false }],
      });
      if (!session) return res.status(404).json({ message: 'Session not found' });

      const now = new Date();
      const expired = new Date(session.expires_at) < now;
      const startedAt = session.started_at ? new Date(session.started_at) : null;
      const durationMins = (session as any).duration_minutes ?? VOICE_INTERVIEW_DURATION_MINUTES;
      const durationMs = durationMins * 60 * 1000;
      const timeLimitExceeded =
        session.status === 'in_progress' &&
        startedAt &&
        now.getTime() - startedAt.getTime() > durationMs;
      if (timeLimitExceeded) {
        await session.update({ status: 'expired', updated_at: new Date() });
      }
      if (expired && session.status !== 'completed') {
        await session.update({ status: 'expired', updated_at: new Date() });
      }

      let questions: { question: string; order: number }[] = [];
      try {
        questions = JSON.parse(session.questions || '[]');
      } catch {}

      let currentQuestion: { question: string; order: number } | null = null;
      if (session.status === 'in_progress' || session.status === 'completed') {
        try {
          const conductorState = JSON.parse((session as any).conductor_state || '{}');
          const history = conductorState.conversationHistory as { role: string; content: string }[] | undefined;
          if (Array.isArray(history) && history.length > 0) {
            for (let i = history.length - 1; i >= 0; i--) {
              if (history[i]?.role === 'assistant' && history[i]?.content) {
                currentQuestion = { question: history[i].content, order: session.current_question_index };
                break;
              }
            }
          }
        } catch {}
        if (!currentQuestion) {
          currentQuestion = questions[session.current_question_index] ?? null;
        }
      }

      const effectiveStatus =
        timeLimitExceeded ? 'expired' : expired && session.status !== 'completed' ? 'expired' : session.status;
      const endsAt =
        session.status === 'in_progress' && startedAt
          ? new Date(startedAt.getTime() + durationMs).toISOString()
          : null;

      let preferredLanguage = 'en';
      try {
        const conductorState = JSON.parse((session as any).conductor_state || '{}');
        preferredLanguage = conductorState.preferredLanguage || 'en';
      } catch {}

      return res.json({
        session: {
          id: session.id,
          jobId: session.job_id,
          jobTitle: (session as any).job?.title ?? 'Job',
          status: effectiveStatus,
          currentQuestionIndex: session.current_question_index,
          maxQuestions: session.max_questions,
          currentQuestion: currentQuestion?.question ?? null,
          questionsCount: questions.length,
          expiresAt: session.expires_at,
          completedAt: session.completed_at,
          startedAt: session.started_at ?? null,
          endsAt,
          preferredLanguage,
        },
      });
    } catch (e: any) {
      console.error('[VoiceInterview] getSession failed:', e?.message);
      return res.status(500).json({ message: e?.message ?? 'Failed to load session' });
    }
  },

  async getReport(req: AuthRequest, res: Response) {
    try {
      await ensureOutcomeColumn();
      await ensureCandidateOutcomeColumn();
      if (!req.user) return res.status(401).json({ message: 'Authentication required' });
      const candidate = await Candidate.findOne({ where: { user_id: req.user.id } });
      if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

      const myAppIds = (await Application.findAll({ where: { candidate_id: candidate.id }, attributes: ['id'] })).map((a) => a.id);

      const { id } = req.params;
      const reportSessionWhere =
        myAppIds.length > 0
          ? { id, [Op.or]: [{ application_id: { [Op.in]: myAppIds } }, { candidate_id: candidate.id }] }
          : { id, candidate_id: candidate.id };
      const session = await VoiceInterviewSession.findOne({
        where: reportSessionWhere,
        include: [{ model: Job, as: 'job', attributes: ['id', 'title'], required: false }],
      });
      if (!session) return res.status(404).json({ message: 'Session not found' });

      await syncVoiceInterviewEndedStatus(session as VoiceInterviewSession & { duration_minutes?: number | null });

      let questions: { question: string; order: number }[] = [];
      let answers: { questionIndex: number; answerText: string; answeredAt: string }[] = [];
      try {
        questions = JSON.parse(session.questions || '[]');
        answers = JSON.parse(session.answers || '[]');
      } catch {}

      let qa: { question: string; answer: string; answeredAt: string | null }[] = [];
      if (session.conductor_state) {
        const fromHistory = buildQaFromConversationHistory(session.conductor_state);
        if (fromHistory.length > 0) qa = fromHistory;
      }
      if (qa.length === 0) {
        qa =
          answers.length > 0
            ? answers.map((a) => ({
                question: (questions[a.questionIndex]?.question ?? '').trim() || `Question ${a.questionIndex + 1}`,
                answer: a.answerText ?? '',
                answeredAt: a.answeredAt ?? null,
              }))
            : questions.map((q, i) => ({
                question: q.question,
                answer: answers[i]?.answerText ?? '',
                answeredAt: answers[i]?.answeredAt ?? null,
              }));
      }

      let candidateOutcome = (session as any).candidate_outcome ?? null;
      let recruiterOutcome = session.outcome ?? null;
      const { questionTexts: questionTextsForSummary, answerTexts: answerTextsForSummary } = getSummaryQuestionAnswerTexts(
        session.conductor_state ?? undefined,
        answers,
        questions,
        qa
      );
      const substantiveAnswerCount = Math.max(
        countSubstantiveInterviewAnswers(answers),
        countSubstantiveAnswersFromQa(qa)
      );
      const hasAnyContent = hasSummarySourceContent(
        questionTextsForSummary,
        answerTextsForSummary,
        qa,
        substantiveAnswerCount
      );

      const missingCandidateOutcome = !candidateOutcome || !String(candidateOutcome).trim();
      const missingRecruiterOutcome = !recruiterOutcome || !String(recruiterOutcome).trim();
      const naturallyFinished = isNaturallyFinishedInterview(session, answers);
      if (naturallyFinished && session.status === 'in_progress') {
        await session.update({
          status: 'completed',
          completed_at: session.completed_at ?? new Date(),
        });
        session.status = 'completed';
      }
      const abandonedInProgress = isAbandonedInProgressSession(session, naturallyFinished);
      const shouldGenerateMidwaySummary =
        abandonedInProgress &&
        substantiveAnswerCount >= MIN_ANSWERS_FOR_MIDWAY_SUMMARY &&
        hasAnyContent &&
        missingCandidateOutcome;
      const shouldRegenerateStaleCompletedOutcome =
        isReportableEndedSession(session.status) &&
        hasAnyContent &&
        (outcomeHasLeftEarlyWording(candidateOutcome) ||
          outcomeHasLeftEarlyWording(recruiterOutcome) ||
          (substantiveAnswerCount >= MIN_ANSWERS_FOR_MIDWAY_SUMMARY &&
            (isGenericFallbackOutcome(candidateOutcome) || isGenericFallbackOutcome(recruiterOutcome))));
      const shouldGenerateCompletedSummary =
        isReportableEndedSession(session.status) &&
        hasAnyContent &&
        (missingCandidateOutcome || missingRecruiterOutcome || shouldRegenerateStaleCompletedOutcome);

      if (shouldGenerateCompletedSummary || shouldGenerateMidwaySummary) {
        try {
          const jobTitle = (session as any).job?.title ?? 'Job';
          const { questionsForOutcome, answersForOutcome } = resolveOutcomeQaInputs(
            questionTextsForSummary,
            answerTextsForSummary,
            qa
          );
          const outcomeResult = await qwenService.generateVoiceInterviewOutcome({
            jobTitle,
            questions: questionsForOutcome.length ? questionsForOutcome : ['Interview completed'],
            answers: answersForOutcome.some((a) => a.trim().length > 0)
              ? answersForOutcome
              : ['No answers recorded'],
          });
          let candidateSummary = outcomeResult.candidateSummary;
          let recruiterSummary = outcomeResult.recruiterSummary;
          if (shouldGenerateMidwaySummary) {
            if (candidateSummary?.trim()) candidateSummary = CANDIDATE_MIDWAY_PREFIX + candidateSummary;
            if (recruiterSummary?.trim()) recruiterSummary = RECRUITER_MIDWAY_PREFIX + recruiterSummary;
          }
          if (candidateSummary?.trim()) candidateOutcome = candidateSummary;
          if (recruiterSummary?.trim()) recruiterOutcome = recruiterSummary;
          if (req.user?.id && (outcomeResult as any)._usage) {
            const u = (outcomeResult as any)._usage;
            logUsage(req.user.id, 'voice_interview', {
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              tokensUsed: u.total_tokens,
            }).catch(() => {});
          }
          await session.update({
            outcome: recruiterSummary?.trim() || recruiterOutcome,
            candidate_outcome: candidateSummary?.trim() || candidateOutcome,
          } as any);
        } catch (err: any) {
          console.error('[VoiceInterview] lazy outcome generation (getReport) failed:', err?.message ?? err);
        }
      }

      const rawCandidateOutcome = candidateOutcome ?? (session as any).candidate_outcome ?? '';
      const finalCandidateOutcome =
        sanitizeInterviewOutcomeText(session.status, rawCandidateOutcome, naturallyFinished) ?? '';
      if (
        isReportableEndedSession(session.status) &&
        finalCandidateOutcome &&
        finalCandidateOutcome !== rawCandidateOutcome
      ) {
        await session.update({ candidate_outcome: finalCandidateOutcome } as any).catch(() => {});
      }

      return res.json({
        report: {
          id: session.id,
          jobId: session.job_id,
          jobTitle: (session as any).job?.title ?? 'Job',
          status: session.status,
          completedAt: session.completed_at,
          outcome: finalCandidateOutcome,
          qa,
          allocatedInterviewQuestions: allocatedInterviewQuestionCount(session),
          maxInterviewTurns: session.max_questions ?? null,
        },
      });
    } catch (e: any) {
      console.error('[VoiceInterview] getReport failed:', e?.message);
      return res.status(500).json({ message: e?.message ?? 'Failed to load report' });
    }
  },

  async start(req: AuthRequest, res: Response) {
    try {
      if (!req.user) return res.status(401).json({ message: 'Authentication required' });
      const candidate = await Candidate.findOne({ where: { user_id: req.user.id } });
      if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

      const myAppIds = (await Application.findAll({ where: { candidate_id: candidate.id }, attributes: ['id'] })).map((a) => a.id);

      const { id } = req.params;
      const startSessionWhere =
        myAppIds.length > 0
          ? { id, [Op.or]: [{ application_id: { [Op.in]: myAppIds } }, { candidate_id: candidate.id }] }
          : { id, candidate_id: candidate.id };
      const session = await VoiceInterviewSession.findOne({
        where: startSessionWhere,
        include: [{ model: Job, as: 'job' }],
      });
      if (!session) return res.status(404).json({ message: 'Session not found' });

      if (new Date(session.expires_at) < new Date()) {
        await session.update({ status: 'expired' });
        return res.status(400).json({ message: 'This voice interview has expired.' });
      }
      if (session.status === 'completed') {
        return res.status(400).json({ message: 'This voice interview is already completed.' });
      }

      const job = (session as any).job as Job & { description?: string; must_have_skills?: string[]; nice_to_have_skills?: string[] };
      const jobTitle = job?.title ?? 'Role';
      const jobDescription = job?.description ?? '';
      const jobSkills = [...(job?.must_have_skills ?? []), ...(job?.nice_to_have_skills ?? [])];
      const t0 = Date.now();
      const candidateContext = await getCandidateCvText(candidate.id);
      console.log(`[VoiceInterview] start: CV text loaded in ${Date.now() - t0}ms (${candidateContext ? candidateContext.length : 0} chars)`);
      const candidateName = (candidate as any).name ?? 'there';
      const preferredLanguage = (req.body as any)?.preferredLanguage || 'en';

      // State-machine conductor: pre-generate questions based on time constraint (intro + N questions)
      const numInterviewQuestions = Math.max(MIN_INTERVIEW_QUESTIONS, session.max_questions - INTRO_TURNS);
      const t1 = Date.now();
      const conductorResult = await qwenService.generateConductorQuestions({
        jobTitle,
        jobDescription,
        jobSkills,
        candidateContext: candidateContext ? candidateContext.substring(0, 2000) : undefined,
        count: numInterviewQuestions,
        preferredLanguage,
      });
      const conductorQuestions = Array.isArray(conductorResult) ? conductorResult : [];
      console.log(`[VoiceInterview] start: conductor questions (${conductorQuestions.length}) in ${Date.now() - t1}ms`);
      const conductorUsage = (conductorResult as any)._usage;
      if (req.user?.id && conductorUsage) {
        logUsage(req.user.id, 'voice_interview', {
          inputTokens: conductorUsage.input_tokens,
          outputTokens: conductorUsage.output_tokens,
          tokensUsed: conductorUsage.total_tokens,
        }).catch(() => {});
      }
      const initialState: InterviewState = {
        phase: 'greeting',
        questionIndex: 0,
        smallTalkTurns: 0,
        conversationHistory: [],
        questions: conductorQuestions,
        candidateName,
        jobTitle,
        interviewerName: 'Aria',
        preferredLanguage,
      };

      const t2 = Date.now();
      const { response, updatedState, usage: startUsage } = await qwenService.startInterview(initialState);
      console.log(`[VoiceInterview] start: opening greeting in ${Date.now() - t2}ms; total ${Date.now() - t0}ms`);
      if (req.user?.id && startUsage) {
        logUsage(req.user.id, 'voice_interview', {
          inputTokens: startUsage.input_tokens,
          outputTokens: startUsage.output_tokens,
          tokensUsed: startUsage.total_tokens,
        }).catch(() => {});
      }

      const questionsForSession = [{ question: response, order: 0 }];
      const maxTurns = INTRO_TURNS + conductorQuestions.length; // greeting + small_talk + context + ready + N questions
      await session.update({
        status: 'in_progress',
        started_at: new Date(),
        questions: JSON.stringify(questionsForSession),
        answers: JSON.stringify([]),
        current_question_index: 0,
        conductor_state: JSON.stringify(updatedState),
        updated_at: new Date(),
      });

      return res.json({
        session: {
          id: session.id,
          status: 'in_progress',
          currentQuestionIndex: 0,
          maxQuestions: maxTurns,
          currentQuestion: response,
          preferredLanguage,
        },
      });
    } catch (e: any) {
      console.error('[VoiceInterview] start failed:', e?.message);
      return res.status(500).json({ message: e?.message ?? 'Failed to start voice interview' });
    }
  },

  async submitAnswer(req: AuthRequest, res: Response) {
    try {
      await ensureOutcomeColumn();
      if (!req.user) return res.status(401).json({ message: 'Authentication required' });
      const candidate = await Candidate.findOne({ where: { user_id: req.user.id } });
      if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

      const myAppIds = (await Application.findAll({ where: { candidate_id: candidate.id }, attributes: ['id'] })).map((a) => a.id);

      const { id } = req.params;
      const { answerText, expressionSummary } = req.body || {};
      const answerSessionWhere =
        myAppIds.length > 0
          ? { id, [Op.or]: [{ application_id: { [Op.in]: myAppIds } }, { candidate_id: candidate.id }] }
          : { id, candidate_id: candidate.id };
      const session = await VoiceInterviewSession.findOne({
        where: answerSessionWhere,
        include: [{ model: Job, as: 'job' }],
      });
      if (!session) return res.status(404).json({ message: 'Session not found' });

      if (session.status !== 'in_progress') {
        return res.status(400).json({ message: 'Session is not in progress.' });
      }

      const startedAt = session.started_at ? new Date(session.started_at) : null;
      const durationMins = (session as any).duration_minutes ?? VOICE_INTERVIEW_DURATION_MINUTES;
      const durationMs = durationMins * 60 * 1000;
      if (startedAt && new Date().getTime() - startedAt.getTime() > durationMs) {
        await session.update({ status: 'expired', updated_at: new Date() });
        return res.status(400).json({ message: 'Time limit exceeded. This interview is closed.' });
      }

      let questions: { question: string; order: number }[] = [];
      let answers: { questionIndex: number; answerText: string; answeredAt: string }[] = [];
      try {
        questions = JSON.parse(session.questions || '[]');
        answers = JSON.parse(session.answers || '[]');
      } catch {}

      const text = typeof answerText === 'string' ? answerText.trim() : '';
      const conductorStateRaw = (session as any).conductor_state;

      if (conductorStateRaw) {
        // State-machine conductor flow
        let state: InterviewState;
        try {
          state = JSON.parse(conductorStateRaw) as InterviewState;
        } catch {
          state = null as unknown as InterviewState;
        }
        if (state?.conversationHistory) {
          const lang = state.preferredLanguage || 'en';

          // Silence check markers: 8s → "Just checking — can you hear me?", 15s → "Are you still there?" (do not advance phase)
          if (isSilenceCheckMarker(text)) {
            const is8s = /\(silence 8s\)/i.test(text);
            const message = is8s ? getSilenceCheck8sMessage(lang) : getSilenceCheck15sMessage(lang);
            const updatedState: InterviewState = {
              ...state,
              conversationHistory: [
                ...state.conversationHistory,
                { role: 'user', content: text },
                { role: 'assistant', content: message },
              ],
            };
            await session.update({
              conductor_state: JSON.stringify(updatedState),
              updated_at: new Date(),
            });
            return res.json({
              done: false,
              session: {
                id: session.id,
                currentQuestionIndex: session.current_question_index,
                maxQuestions: session.max_questions,
                currentQuestion: message,
              },
            });
          }

          // Silence / no response → reply "Are you there?" without advancing phase (persist so refetch keeps it)
          if (isSilenceAnswer(text)) {
            const areYouThere = getAreYouThereMessage(lang);
            const updatedState: InterviewState = {
              ...state,
              conversationHistory: [
                ...state.conversationHistory,
                { role: 'user', content: '(No response)' },
                { role: 'assistant', content: areYouThere },
              ],
            };
            await session.update({
              conductor_state: JSON.stringify(updatedState),
              updated_at: new Date(),
            });
            return res.json({
              done: false,
              session: {
                id: session.id,
                currentQuestionIndex: session.current_question_index,
                maxQuestions: session.max_questions,
                currentQuestion: areYouThere,
              },
            });
          }

          // Reschedule was offered and user confirmed → end call
          if (state.rescheduleOffered && userConfirmedReschedule(text)) {
            await session.update({
              conductor_state: JSON.stringify({ ...state, conversationHistory: [...state.conversationHistory, { role: 'user' as const, content: text }, { role: 'assistant' as const, content: 'We\'ll reschedule. Goodbye.' }] }),
              status: 'completed',
              completed_at: new Date(),
              outcome: 'Candidate requested reschedule due to technical issues. The call was ended by mutual agreement.',
              updated_at: new Date(),
            });
            const goodbyeMsg = lang.startsWith('ar') ? 'سنعيد الجدولة. مع السلامة.' : lang.startsWith('es') ? 'Reagendaremos. Hasta luego.' : 'We\'ll reschedule and be in touch. Goodbye.';
            return res.json({
              done: true,
              message: 'Reschedule confirmed. Goodbye!',
              session: { id: session.id, status: 'completed', currentQuestion: goodbyeMsg },
            });
          }

          // Candidate reports tech issue → offer reschedule (do not advance phase)
          if (!state.rescheduleOffered && isTechnicalIssue(text)) {
            const updatedState: InterviewState = {
              ...state,
              rescheduleOffered: true,
              conversationHistory: [
                ...state.conversationHistory,
                { role: 'user', content: text },
                { role: 'assistant', content: getRescheduleOfferMessage(lang) },
              ],
            };
            await session.update({
              conductor_state: JSON.stringify(updatedState),
              updated_at: new Date(),
            });
            return res.json({
              done: false,
              session: {
                id: session.id,
                currentQuestionIndex: session.current_question_index,
                maxQuestions: session.max_questions,
                currentQuestion: getRescheduleOfferMessage(lang),
              },
            });
          }

          const isInterviewPhase = state.phase === 'interview';
          const currentInterviewQuestion = (state.questions && state.questions[state.questionIndex]);
          if (isInterviewPhase && currentInterviewQuestion) {
            questions.push({ question: currentInterviewQuestion, order: state.questionIndex });
            answers.push({
              questionIndex: state.questionIndex,
              answerText: text || '(No answer provided)',
              answeredAt: new Date().toISOString(),
            });
          }

          const { response: nextLine, updatedState, usage: conductUsage } = await qwenService.conductInterview(state, text || '(No answer provided)');
          if (req.user?.id && conductUsage) {
            logUsage(req.user.id, 'voice_interview', {
              inputTokens: conductUsage.input_tokens,
              outputTokens: conductUsage.output_tokens,
              tokensUsed: conductUsage.total_tokens,
            }).catch(() => {});
          }

          const isClosing = updatedState.phase === 'closing';
          const nextIndex = questions.length;

          if (isClosing) {
            const job = (session as any).job as Job & { title?: string };
            const jobTitle = job?.title ?? 'Role';
            let recruiterOutcome: string | null = null;
            let candidateOutcome: string | null = null;
            try {
              await ensureCandidateOutcomeColumn();
              const qaFallback = buildQaFromConversationHistory(JSON.stringify(updatedState));
              const { questionTexts, answerTexts } = getSummaryQuestionAnswerTexts(
                JSON.stringify(updatedState),
                answers,
                questions,
                qaFallback
              );
              const { questionsForOutcome, answersForOutcome } = resolveOutcomeQaInputs(
                questionTexts,
                answerTexts,
                qaFallback
              );
              if (
                questionsForOutcome.length > 0 ||
                answersForOutcome.some((a) => a.trim().length > 0)
              ) {
                const outcomeResult = await qwenService.generateVoiceInterviewOutcome({
                  jobTitle,
                  questions: questionsForOutcome.length ? questionsForOutcome : ['Interview completed'],
                  answers: answersForOutcome.some((a) => a.trim().length > 0)
                    ? answersForOutcome
                    : ['No answers recorded'],
                  expressionSummary: typeof expressionSummary === 'string' ? expressionSummary : undefined,
                });
                recruiterOutcome = outcomeResult.recruiterSummary?.trim() || null;
                candidateOutcome = outcomeResult.candidateSummary?.trim() || null;
                if (req.user?.id && (outcomeResult as any)._usage) {
                  const u = (outcomeResult as any)._usage;
                  logUsage(req.user.id, 'voice_interview', {
                    inputTokens: u.input_tokens,
                    outputTokens: u.output_tokens,
                    tokensUsed: u.total_tokens,
                  }).catch(() => {});
                }
              }
            } catch (err) {
              console.error('[VoiceInterview] outcome generation failed:', err);
            }
            await session.update({
              questions: JSON.stringify(questions),
              answers: JSON.stringify(answers),
              current_question_index: nextIndex,
              conductor_state: JSON.stringify(updatedState),
              status: 'completed',
              completed_at: new Date(),
              outcome: recruiterOutcome ?? undefined,
              candidate_outcome: candidateOutcome ?? undefined,
              updated_at: new Date(),
            } as any);
            return res.json({
              done: true,
              message: 'Voice interview completed. Thank you!',
              session: { id: session.id, status: 'completed', currentQuestion: nextLine, outcome: candidateOutcome ?? undefined },
            });
          }

          await session.update({
            questions: JSON.stringify(questions),
            answers: JSON.stringify(answers),
            current_question_index: nextIndex,
            conductor_state: JSON.stringify(updatedState),
            updated_at: new Date(),
          });

          const maxTurns = 4 + (state.questions?.length ?? 0);
          return res.json({
            done: false,
            session: {
              id: session.id,
              currentQuestionIndex: nextIndex,
              maxQuestions: maxTurns,
              currentQuestion: nextLine,
            },
          });
        }
      }

      // Fallback: legacy flow (no conductor_state)
      answers.push({
        questionIndex: session.current_question_index,
        answerText: text || '(No answer provided)',
        answeredAt: new Date().toISOString(),
      });

      const nextIndex = session.current_question_index + 1;
      const isLast = nextIndex >= session.max_questions;

      if (isLast) {
        const job = (session as any).job as Job & { title?: string };
        const jobTitle = job?.title ?? 'Role';
        let recruiterOutcome: string | null = null;
        let candidateOutcome: string | null = null;
        try {
          await ensureCandidateOutcomeColumn();
          const legacyQa = answers.map((a, i) => ({
            question: (questions[a.questionIndex]?.question ?? questions[i]?.question ?? '').trim(),
            answer: (a.answerText ?? '').trim(),
          }));
          const { questionTexts, answerTexts } = filterToInterviewQa(questions, answers);
          const { questionsForOutcome, answersForOutcome } = resolveOutcomeQaInputs(
            questionTexts,
            answerTexts,
            legacyQa
          );
          if (
            questionsForOutcome.length > 0 ||
            answersForOutcome.some((a) => a.trim().length > 0)
          ) {
            const outcomeResult = await qwenService.generateVoiceInterviewOutcome({
              jobTitle,
              questions: questionsForOutcome.length ? questionsForOutcome : ['Interview completed'],
              answers: answersForOutcome.some((a) => a.trim().length > 0)
                ? answersForOutcome
                : ['No answers recorded'],
              expressionSummary: typeof expressionSummary === 'string' ? expressionSummary : undefined,
            });
            recruiterOutcome = outcomeResult.recruiterSummary?.trim() || null;
            candidateOutcome = outcomeResult.candidateSummary?.trim() || null;
            if (req.user?.id && (outcomeResult as any)._usage) {
              const u = (outcomeResult as any)._usage;
              logUsage(req.user.id, 'voice_interview', {
                inputTokens: u.input_tokens,
                outputTokens: u.output_tokens,
                tokensUsed: u.total_tokens,
              }).catch(() => {});
            }
          }
        } catch (err) {
          console.error('[VoiceInterview] outcome generation failed:', err);
        }
        await session.update({
          answers: JSON.stringify(answers),
          current_question_index: nextIndex,
          status: 'completed',
          completed_at: new Date(),
          outcome: recruiterOutcome ?? undefined,
          candidate_outcome: candidateOutcome ?? undefined,
          updated_at: new Date(),
        } as any);
        return res.json({
          done: true,
          message: 'Voice interview completed. Thank you!',
          session: { id: session.id, status: 'completed', outcome: candidateOutcome ?? undefined },
        });
      }

      const job = (session as any).job as Job & { description?: string; must_have_skills?: string[]; nice_to_have_skills?: string[] };
      const jobTitle = job?.title ?? 'Role';
      const jobDescription = job?.description ?? '';
      const jobSkills = [...(job?.must_have_skills ?? []), ...(job?.nice_to_have_skills ?? [])];
      const candidateContext = await getCandidateCvText(candidate.id);
      const previousQAndA = questions.slice(0, nextIndex).map((q, i) => ({
        question: q.question,
        answer: answers[i]?.answerText ?? '',
      }));
      const candidateName = (candidate as any).name ?? undefined;
      const durationMinutes = (session as any).duration_minutes ?? undefined;
      const { question: nextQuestion } = await qwenService.generateVoiceInterviewQuestion({
        jobTitle,
        jobDescription,
        jobSkills,
        candidateContext: candidateContext ? candidateContext.substring(0, 2000) : undefined,
        candidateName,
        previousQAndA,
        questionIndex: nextIndex,
        maxQuestions: session.max_questions,
        durationMinutes,
      });

      questions.push({ question: nextQuestion, order: nextIndex });
      await session.update({
        questions: JSON.stringify(questions),
        answers: JSON.stringify(answers),
        current_question_index: nextIndex,
        updated_at: new Date(),
      });

      return res.json({
        done: false,
        session: {
          id: session.id,
          currentQuestionIndex: nextIndex,
          maxQuestions: session.max_questions,
          currentQuestion: nextQuestion,
        },
      });
    } catch (e: any) {
      console.error('[VoiceInterview] submitAnswer failed:', e?.message);
      return res.status(500).json({ message: e?.message ?? 'Failed to submit answer' });
    }
  },

  /** Recruiter/company: get voice interview report for an application. */
  async getReportForApplication(req: AuthRequest, res: Response) {
    try {
      await ensureOutcomeColumn();
      await ensureCandidateOutcomeColumn();
      const { applicationId } = req.params;
      if (!applicationId) return res.status(400).json({ message: 'applicationId is required' });

      const application = await Application.findByPk(applicationId, {
        include: [{ model: Job, as: 'job', attributes: ['id', 'title', 'company_id'] }],
      }) as (Application & { job?: JobWithCompany }) | null;
      if (!application?.job) return res.status(404).json({ message: 'Application or job not found' });
      await assertCompanyAccess(req, application.job.company_id);

      const sessions = await VoiceInterviewSession.findAll({
        where: { application_id: applicationId },
        include: [{ model: Job, as: 'job', attributes: ['id', 'title'], required: false }],
        order: [['created_at', 'DESC']],
        limit: 1,
      });
      const session = sessions[0] ?? null;
      if (!session) return res.status(404).json({ message: 'No voice interview found for this application.' });

      await syncVoiceInterviewEndedStatus(session as VoiceInterviewSession & { duration_minutes?: number | null });

      let questions: { question: string; order: number }[] = [];
      let answers: { questionIndex: number; answerText: string; answeredAt: string }[] = [];
      try {
        questions = JSON.parse(session.questions || '[]');
        answers = JSON.parse(session.answers || '[]');
      } catch {}

      let qa: { question: string; answer: string; answeredAt: string | null }[] = [];
      if (session.conductor_state) {
        const fromHistory = buildQaFromConversationHistory(session.conductor_state);
        if (fromHistory.length > 0) qa = fromHistory;
      }
      if (qa.length === 0) {
        qa =
          answers.length > 0
            ? answers.map((a) => ({
                question: (questions[a.questionIndex]?.question ?? '').trim() || `Question ${a.questionIndex + 1}`,
                answer: a.answerText ?? '',
                answeredAt: a.answeredAt ?? null,
              }))
            : questions.map((q, i) => ({
                question: q.question,
                answer: answers[i]?.answerText ?? '',
                answeredAt: answers[i]?.answeredAt ?? null,
              }));
      }

      let outcome = session.outcome ?? null;
      const candidateOutcomeStored = (session as any).candidate_outcome ?? null;
      const { questionTexts: questionTextsForSummary, answerTexts: answerTextsForSummary } = getSummaryQuestionAnswerTexts(
        session.conductor_state ?? undefined,
        answers,
        questions,
        qa
      );
      const substantiveAnswerCount = Math.max(
        countSubstantiveInterviewAnswers(answers),
        countSubstantiveAnswersFromQa(qa)
      );
      const hasAnyContent = hasSummarySourceContent(
        questionTextsForSummary,
        answerTextsForSummary,
        qa,
        substantiveAnswerCount
      );

      const missingRecruiterOutcome = !outcome || !String(outcome).trim();
      const missingCandidateOutcome = !candidateOutcomeStored || !String(candidateOutcomeStored).trim();
      const naturallyFinished = isNaturallyFinishedInterview(session, answers);
      if (naturallyFinished && session.status === 'in_progress') {
        await session.update({
          status: 'completed',
          completed_at: session.completed_at ?? new Date(),
        });
        session.status = 'completed';
      }
      const abandonedInProgress = isAbandonedInProgressSession(session, naturallyFinished);
      const shouldGenerateMidwaySummary =
        abandonedInProgress &&
        substantiveAnswerCount >= MIN_ANSWERS_FOR_MIDWAY_SUMMARY &&
        hasAnyContent &&
        missingRecruiterOutcome;
      const shouldRegenerateStaleCompletedOutcome =
        isReportableEndedSession(session.status) &&
        hasAnyContent &&
        (outcomeHasLeftEarlyWording(outcome) ||
          outcomeHasLeftEarlyWording(candidateOutcomeStored) ||
          (substantiveAnswerCount >= MIN_ANSWERS_FOR_MIDWAY_SUMMARY &&
            (isGenericFallbackOutcome(outcome) || isGenericFallbackOutcome(candidateOutcomeStored))));
      const shouldGenerateCompletedSummary =
        isReportableEndedSession(session.status) &&
        hasAnyContent &&
        (missingRecruiterOutcome || missingCandidateOutcome || shouldRegenerateStaleCompletedOutcome);

      if (shouldGenerateCompletedSummary || shouldGenerateMidwaySummary) {
        try {
          const jobTitle = (session as any).job?.title ?? 'Job';
          const { questionsForOutcome, answersForOutcome } = resolveOutcomeQaInputs(
            questionTextsForSummary,
            answerTextsForSummary,
            qa
          );
          const outcomeResult = await qwenService.generateVoiceInterviewOutcome({
            jobTitle,
            questions: questionsForOutcome.length ? questionsForOutcome : ['Interview completed'],
            answers: answersForOutcome.some((a) => a.trim().length > 0)
              ? answersForOutcome
              : ['No answers recorded'],
          });
          let candidateSummary = outcomeResult.candidateSummary;
          let recruiterSummary = outcomeResult.recruiterSummary;
          if (shouldGenerateMidwaySummary) {
            if (candidateSummary?.trim()) candidateSummary = CANDIDATE_MIDWAY_PREFIX + candidateSummary;
            if (recruiterSummary?.trim()) recruiterSummary = RECRUITER_MIDWAY_PREFIX + recruiterSummary;
          }
          if (recruiterSummary?.trim()) outcome = recruiterSummary;
          const cand = await Candidate.findByPk(session.candidate_id, { attributes: ['user_id'] });
          if (cand?.user_id && (outcomeResult as any)._usage) {
            const u = (outcomeResult as any)._usage;
            logUsage((cand as any).user_id, 'voice_interview', {
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              tokensUsed: u.total_tokens,
            }).catch(() => {});
          }
          await session.update({
            outcome: recruiterSummary?.trim() || outcome,
            candidate_outcome: candidateSummary?.trim() || candidateOutcomeStored,
          } as any);
        } catch (err: any) {
          console.error('[VoiceInterview] lazy outcome generation (getReportForApplication) failed:', err?.message ?? err);
        }
      }

      const rawRecruiterOutcome = outcome ?? session.outcome ?? '';
      const finalRecruiterOutcome =
        sanitizeInterviewOutcomeText(session.status, rawRecruiterOutcome, naturallyFinished) ?? '';
      if (
        isReportableEndedSession(session.status) &&
        finalRecruiterOutcome &&
        finalRecruiterOutcome !== rawRecruiterOutcome
      ) {
        await session.update({ outcome: finalRecruiterOutcome } as any).catch(() => {});
      }

      return res.json({
        report: {
          id: session.id,
          applicationId: applicationId,
          jobId: session.job_id,
          jobTitle: (session as any).job?.title ?? 'Job',
          status: session.status,
          completedAt: session.completed_at,
          outcome: finalRecruiterOutcome,
          qa,
          allocatedInterviewQuestions: allocatedInterviewQuestionCount(session),
          maxInterviewTurns: session.max_questions ?? null,
        },
      });
    } catch (e: any) {
      console.error('[VoiceInterview] getReportForApplication failed:', e?.message);
      return res.status(e?.status === 403 ? 403 : 500).json({ message: e?.message ?? 'Failed to load report' });
    }
  },

  /** Speech config: whether Alibaba TTS is available (same key as Qwen). */
  async speechConfig(_req: AuthRequest, res: Response) {
    return res.json({ useAlibabaTTS: isAlibabaSpeechAvailable() });
  },

  /** Alibaba TTS: synthesize interview line. Returns audio/wav. */
  async tts(req: AuthRequest, res: Response) {
    try {
      const { text, languageCode } = (req.body || {}) as { text?: string; languageCode?: string };
      if (!text || typeof text !== 'string') {
        return res.status(400).json({ message: 'text is required' });
      }
      const textToSpeak = text.trim().slice(0, 2000);
      const result = await synthesizeSpeech(textToSpeak, languageCode || 'en');
      if (!result) {
        return res.status(503).json({ message: 'TTS not available or failed. Use browser speech as fallback.' });
      }
      if (req.user?.id && textToSpeak.length > 0) {
        logUsage(req.user.id, 'voice_tts', { ttsCharacters: textToSpeak.length }).catch(() => {});
      }
      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(result.audioBuffer);
    } catch (e: any) {
      if (req.user?.id) logUsageFailure(req.user.id, 'voice_tts', inferErrorType(e)).catch(() => {});
      console.error('[VoiceInterview] TTS failed:', e?.message);
      return res.status(500).json({ message: e?.message ?? 'TTS failed' });
    }
  },
};
