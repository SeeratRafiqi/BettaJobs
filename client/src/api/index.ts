import { apiGet, apiPost, apiPut, apiPatch, apiDelete, apiUpload, apiPostBlob, setAuthToken, API_BASE_URL } from '@/lib/apiClient';
import type {
  Candidate,
  CandidateProfile,
  CompanyProfile,
  Job,
  MatchResult,
  AdminNote,
  DashboardStats,
  UploadResult,
  CvStatus,
  User,
  JobReport,
  Role,
  Application,
  ApplicationStatus,
  BrowseJobsResponse,
  CompanyStats,
  PipelineStage,
  JobPipeline,
  AppNotification,
  NotificationListResponse,
  ApplicationHistoryEntry,
  ConversationPreview,
  MessagesResponse,
  ChatMessage,
  SavedJobEntry,
  CompanyAnalytics,
  CandidateAnalytics,
  AdminAnalytics,
  AdminUsage,
  AdminCallStats,
  TeamMember,
  PrivacySettings,
  MemberRole,
  SavedCoverLetter,
  InterviewAssessment,
  InterviewAssessmentReport,
  VoiceInterviewSessionSummary,
  VoiceInterviewSessionDetail,
  VoiceInterviewForApplication,
  VoiceInterviewReport,
} from '@/types';

// ==================== AUTH ====================
export async function register(data: {
  email: string;
  password: string;
  name: string;
  role: 'candidate' | 'company';
}): Promise<{ token: string; user: User }> {
  const response = await apiPost<{ token: string; user: User }>('/auth/register', data);
  if (response.token) {
    setAuthToken(response.token);
  }
  return response;
}

export async function login(emailOrUsername: string, password: string): Promise<{ token: string; user: User }> {
  const response = await apiPost<{ token: string; user: User }>('/auth/login', {
    email: emailOrUsername,
    password,
  });
  if (response.token) {
    setAuthToken(response.token);
  }
  return response;
}

export async function logout(): Promise<void> {
  await apiPost('/auth/logout');
  setAuthToken(null);
}

export async function getCurrentUser(): Promise<User> {
  return apiGet<User>('/auth/me');
}

// ==================== CANDIDATE PROFILE (self) ====================
export async function getCandidateProfile(): Promise<CandidateProfile> {
  return apiGet<CandidateProfile>('/candidate/profile');
}

export async function updateCandidateProfile(data: Partial<CandidateProfile>): Promise<{ message: string }> {
  return apiPut<{ message: string }>('/candidate/profile', data);
}

export async function uploadCandidatePhoto(file: File): Promise<{ photoUrl: string }> {
  const formData = new FormData();
  formData.append('photo', file);
  return apiUpload<{ photoUrl: string }>('/candidate/profile/photo', formData);
}

export async function deleteCandidatePhoto(): Promise<{ message: string }> {
  return apiPost<{ message: string }>('/candidate/profile/photo/remove', {});
}

/**
 * Upload CV as the authenticated candidate (links to own profile).
 * Triggers matrix generation + job matching in the background.
 */
export async function uploadCandidateCv(file: File): Promise<{ message: string; cvFile: any }> {
  const formData = new FormData();
  formData.append('file', file);
  return apiUpload<{ message: string; cvFile: any }>('/candidate/cv/upload', formData);
}

/**
 * Re-run matrix generation + matching for the authenticated candidate.
 */
export async function rerunCandidateMatching(): Promise<{ message: string }> {
  return apiPost<{ message: string }>('/candidate/cv/rerun');
}

// ==================== COMPANY PROFILE (self) ====================
export async function getCompanyProfile(): Promise<CompanyProfile> {
  return apiGet<CompanyProfile>('/company/profile');
}

export async function updateCompanyProfile(data: Partial<CompanyProfile>): Promise<{ message: string }> {
  return apiPut<{ message: string }>('/company/profile', data);
}

export async function uploadCompanyLogo(file: File): Promise<{ logoUrl: string }> {
  const formData = new FormData();
  formData.append('logo', file);
  return apiUpload<{ logoUrl: string }>('/company/profile/logo', formData);
}

// ==================== CANDIDATES (admin) ====================
export async function listCandidates(filters?: {
  status?: CvStatus;
  country?: string;
  search?: string;
  tags?: string[];
  minScore?: number;
  sortBy?: string;
}): Promise<Candidate[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.append('status', filters.status);
  if (filters?.country) params.append('country', filters.country);
  if (filters?.search) params.append('search', filters.search);
  if (filters?.tags) filters.tags.forEach(tag => params.append('tags', tag));
  if (filters?.minScore) params.append('minScore', filters.minScore.toString());
  if (filters?.sortBy) params.append('sortBy', filters.sortBy);

  const query = params.toString();
  return apiGet<Candidate[]>(`/candidates${query ? `?${query}` : ''}`);
}

export async function getCandidate(id: string): Promise<Candidate> {
  return apiGet<Candidate>(`/candidates/${id}`);
}

export async function updateCandidate(
  id: string,
  updates: Partial<Candidate>
): Promise<Candidate> {
  return apiPut<Candidate>(`/candidates/${id}`, updates);
}

export async function deleteCandidate(id: string): Promise<void> {
  await apiDelete(`/candidates/${id}`);
}

export async function uploadCvs(
  files: File[],
  batchTag?: string
): Promise<UploadResult> {
  const formData = new FormData();
  files.forEach(file => {
    formData.append('files', file);
  });
  if (batchTag) {
    formData.append('batchTag', batchTag);
  }

  return apiUpload<UploadResult>('/candidates/upload', formData);
}

export async function getCandidateMatrix(candidateId: string) {
  return apiGet(`/candidates/${candidateId}/matrix`);
}

export async function rerunMatching(candidateId: string, regenerateMatrix: boolean = false): Promise<void> {
  await apiPost(`/candidates/${candidateId}/rerun-matching`, { regenerateMatrix });
}

// ==================== JOBS ====================
export async function listJobs(filters?: {
  status?: string;
  locationType?: string;
  country?: string;
}): Promise<Job[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.append('status', filters.status);
  if (filters?.locationType) params.append('locationType', filters.locationType);
  if (filters?.country) params.append('country', filters.country);

  const query = params.toString();
  return apiGet<Job[]>(`/jobs${query ? `?${query}` : ''}`);
}

export async function getJob(id: string): Promise<Job> {
  return apiGet<Job>(`/jobs/${id}`);
}

export async function createJob(
  jobData: Omit<Job, 'id' | 'createdAt' | 'matrix'>
): Promise<Job> {
  return apiPost<Job>('/jobs', jobData);
}

export async function createJobFromUrl(
  url: string,
  status: 'draft' | 'published' = 'draft'
): Promise<Job> {
  return apiPost<Job>('/jobs/from-url', { url, status });
}

export async function createJobFromPdf(
  pdfFile: File,
  status: 'draft' | 'published' = 'draft'
): Promise<Job> {
  const formData = new FormData();
  formData.append('pdf', pdfFile);
  formData.append('status', status);
  return apiUpload<Job>('/jobs/from-pdf', formData);
}

export async function updateJob(id: string, updates: Partial<Job>): Promise<Job> {
  return apiPut<Job>(`/jobs/${id}`, updates);
}

export async function deleteJob(id: string): Promise<void> {
  await apiDelete(`/jobs/${id}`);
}

export async function getJobMatrix(jobId: string) {
  return apiGet(`/jobs/${jobId}/matrix`);
}

export async function generateJobMatrix(jobId: string): Promise<void> {
  await apiPost(`/jobs/${jobId}/generate-matrix`);
}

export async function updateJobMatrix(jobId: string, matrix: {
  requiredSkills: { skill: string; weight: number }[];
  preferredSkills: { skill: string; weight: number }[];
  experienceWeight: number;
  locationWeight: number;
  domainWeight: number;
}) {
  return apiPut(`/jobs/${jobId}/matrix`, matrix);
}

// ==================== REPORTS ====================
export async function generateJobReport(jobId: string): Promise<JobReport> {
  return apiPost<JobReport>(`/jobs/${jobId}/generate-report`);
}

export async function getJobReport(jobId: string): Promise<JobReport> {
  return apiGet<JobReport>(`/jobs/${jobId}/report`);
}

export async function deleteJobReport(jobId: string): Promise<void> {
  await apiDelete(`/jobs/${jobId}/report`);
}

// ==================== MATCHES ====================
export async function getMatchesForJob(jobId: string): Promise<(MatchResult & { candidate?: any })[]> {
  return apiGet<(MatchResult & { candidate?: any })[]>(`/matches/job/${jobId}`);
}

export async function getCompanyMatchedCandidates(): Promise<any[]> {
  return apiGet<any[]>('/matches/company/all');
}

export async function getMatchesForCandidate(candidateId: string): Promise<
  (MatchResult & { job?: Job })[]
> {
  return apiGet<(MatchResult & { job?: Job })[]>(`/matches/candidate/${candidateId}`);
}

export async function calculateMatches(jobId: string): Promise<void> {
  await apiPost(`/matches/job/${jobId}/calculate`);
}

export async function shortlistCandidate(
  matchId: string
): Promise<MatchResult> {
  return apiPost<MatchResult>(`/matches/${matchId}/shortlist`);
}

export async function rejectCandidate(
  matchId: string
): Promise<MatchResult> {
  return apiPost<MatchResult>(`/matches/${matchId}/reject`);
}

// ==================== NOTES ====================
export async function getNotes(candidateId: string): Promise<AdminNote[]> {
  return apiGet<AdminNote[]>(`/candidates/${candidateId}/notes`);
}

export async function addNote(
  candidateId: string,
  content: string,
  authorName: string
): Promise<AdminNote> {
  return apiPost<AdminNote>(`/candidates/${candidateId}/notes`, { content, authorName });
}

// ==================== TAGS ====================
export async function getCandidateTags(candidateId: string) {
  return apiGet(`/candidates/${candidateId}/tags`);
}

export async function addCandidateTag(candidateId: string, name: string, color?: string) {
  return apiPost(`/candidates/${candidateId}/tags`, { name, color });
}

export async function deleteCandidateTag(candidateId: string, tagId: string) {
  await apiDelete(`/candidates/${candidateId}/tags/${tagId}`);
}

// ==================== DASHBOARD ====================
export async function getAdminDashboardStats(): Promise<DashboardStats> {
  return apiGet<DashboardStats>('/dashboard/stats');
}

export async function getRecentUploads(): Promise<Candidate[]> {
  return apiGet<Candidate[]>('/dashboard/recent-uploads');
}

export async function getRecentJobs(): Promise<Job[]> {
  return apiGet<Job[]>('/dashboard/recent-jobs');
}

// ==================== BULK OPERATIONS ====================
export async function getBulkCandidatesSummary() {
  return apiGet<{
    totalCandidates: number;
    withMatrix: number;
    withoutMatrix: number;
    withCvText: number;
    totalJobs: number;
    jobsWithMatrix: number;
  }>('/bulk-operations/candidates-summary');
}

export async function startBulkRegenerateMatrices(options?: { candidateIds?: string[]; onlyMissing?: boolean }) {
  return apiPost<{ jobId: string; message: string }>('/bulk-operations/regenerate-matrices', options || {});
}

export async function startBulkRerunMatching(options?: { candidateIds?: string[] }) {
  return apiPost<{ jobId: string; message: string }>('/bulk-operations/rerun-matching', options || {});
}

export async function startBulkRegenerateAndMatch(options?: { candidateIds?: string[]; onlyMissing?: boolean }) {
  return apiPost<{ jobId: string; message: string }>('/bulk-operations/regenerate-and-match', options || {});
}

export async function getBulkJobStatus(jobId: string) {
  return apiGet<{
    id: string;
    type: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
    errors: { candidateId: string; name: string; error: string }[];
    startedAt: string;
    completedAt?: string;
    currentCandidate?: string;
  }>(`/bulk-operations/status/${jobId}`);
}

export async function getAllBulkJobs() {
  return apiGet<any[]>('/bulk-operations/status');
}

export async function cancelBulkJob(jobId: string) {
  return apiPost(`/bulk-operations/cancel/${jobId}`);
}

// ==================== CANDIDATE-FACING ====================
export async function getRecommendedJobs(candidateId: string): Promise<
  (MatchResult & { job?: Job })[]
> {
  return getMatchesForCandidate(candidateId);
}

// ==================== JOB BROWSING (public / candidate) ====================
export async function browseJobs(filters?: {
  search?: string;
  country?: string;
  locationType?: string;
  seniorityLevel?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
}): Promise<BrowseJobsResponse> {
  const params = new URLSearchParams();
  if (filters?.search) params.append('search', filters.search);
  if (filters?.country) params.append('country', filters.country);
  if (filters?.locationType) params.append('locationType', filters.locationType);
  if (filters?.seniorityLevel) params.append('seniorityLevel', filters.seniorityLevel);
  if (filters?.page) params.append('page', filters.page.toString());
  if (filters?.limit) params.append('limit', filters.limit.toString());
  if (filters?.sortBy) params.append('sortBy', filters.sortBy);

  const query = params.toString();
  return apiGet<BrowseJobsResponse>(`/browse${query ? `?${query}` : ''}`);
}

export async function getJobPublic(id: string): Promise<Job & { match?: any; applicationStatus?: ApplicationStatus | null }> {
  return apiGet(`/browse/${id}`);
}

// ==================== APPLICATIONS (candidate) ====================
export async function applyToJob(
  jobId: string,
  coverLetter?: string,
  options?: { cvType?: 'original' | 'tailored'; tailoredCvText?: string }
): Promise<Application> {
  return apiPost<Application>('/applications', {
    jobId,
    coverLetter,
    cvType: options?.cvType,
    tailoredCvText: options?.tailoredCvText,
  });
}

export async function getMyApplications(status?: string): Promise<Application[]> {
  const params = new URLSearchParams();
  if (status && status !== 'all') params.append('status', status);
  const query = params.toString();
  return apiGet<Application[]>(`/applications/mine${query ? `?${query}` : ''}`);
}

export async function withdrawApplication(applicationId: string): Promise<{ message: string }> {
  return apiPut<{ message: string }>(`/applications/${applicationId}/withdraw`);
}

// ==================== APPLICATIONS (company) ====================
export async function getApplicationsForJob(jobId: string, filters?: {
  status?: string;
  sortBy?: string;
}): Promise<Application[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.append('status', filters.status);
  if (filters?.sortBy) params.append('sortBy', filters.sortBy);
  const query = params.toString();
  return apiGet<Application[]>(`/applications/job/${jobId}${query ? `?${query}` : ''}`);
}

export async function updateApplicationStatus(applicationId: string, status: ApplicationStatus): Promise<{ message: string }> {
  return apiPut<{ message: string }>(`/applications/${applicationId}/status`, { status });
}

export async function getCompanyStats(): Promise<CompanyStats> {
  return apiGet<CompanyStats>('/applications/company-stats');
}

// ==================== INTERVIEW ASSESSMENTS ====================
export async function getMyInterviewAssessments(): Promise<{ assessments: InterviewAssessment[] }> {
  return apiGet<{ assessments: InterviewAssessment[] }>('/interviews/mine');
}

export async function getInterviewAssessment(id: string): Promise<{ assessment: InterviewAssessment }> {
  return apiGet<{ assessment: InterviewAssessment }>(`/interviews/${id}`);
}

export async function startInterviewAssessment(id: string): Promise<{ assessment: InterviewAssessment }> {
  return apiPost<{ assessment: InterviewAssessment }>(`/interviews/${id}/start`);
}

export async function saveInterviewAnswer(
  assessmentId: string,
  questionId: string,
  selectedOption: string
): Promise<{ message: string }> {
  return apiPut<{ message: string }>(`/interviews/${assessmentId}/answers/${questionId}`, { selectedOption });
}

export async function submitInterviewAssessment(
  id: string,
  autoSubmitted: boolean = false
): Promise<{ message: string; assessment: InterviewAssessment }> {
  return apiPost<{ message: string; assessment: InterviewAssessment }>(`/interviews/${id}/submit`, { autoSubmitted });
}

export async function getInterviewAssessmentReport(id: string): Promise<{ report: InterviewAssessmentReport }> {
  return apiGet<{ report: InterviewAssessmentReport }>(`/interviews/${id}/report`);
}

export async function assignInterviewAssessment(applicationId: string): Promise<{ message: string; assessment: InterviewAssessment }> {
  return apiPost<{ message: string; assessment: InterviewAssessment }>('/interviews/assign', { applicationId });
}

export async function reissueInterviewAssessment(id: string): Promise<{ message: string; assessment: InterviewAssessment }> {
  return apiPost<{ message: string; assessment: InterviewAssessment }>(`/interviews/${id}/reissue`);
}

export async function getInterviewAssessmentsForApplication(applicationId: string): Promise<{ assessments: InterviewAssessment[] }> {
  return apiGet<{ assessments: InterviewAssessment[] }>(`/interviews/application/${applicationId}`);
}

// ==================== VOICE INTERVIEWS ====================
export async function getMyVoiceInterviewSessions(): Promise<{ sessions: VoiceInterviewSessionSummary[] }> {
  return apiGet<{ sessions: VoiceInterviewSessionSummary[] }>('/voice-interviews/mine');
}

/** Create a test voice interview session (no job/apply/assign flow). For testing only. */
export async function createTestVoiceInterviewSession(): Promise<{
  message: string;
  sessionId: string;
  url: string;
}> {
  return apiPost<{ message: string; sessionId: string; url: string }>('/voice-interviews/create-test-session', {});
}

export async function getVoiceInterviewSession(id: string): Promise<{ session: VoiceInterviewSessionDetail }> {
  return apiGet<{ session: VoiceInterviewSessionDetail }>(`/voice-interviews/session/${id}`);
}

export async function getVoiceInterviewForApplication(applicationId: string): Promise<{
  session: VoiceInterviewForApplication | null;
}> {
  return apiGet<{ session: VoiceInterviewForApplication | null }>(
    `/voice-interviews/for-application/${applicationId}`
  );
}

export async function getVoiceInterviewReport(id: string): Promise<{ report: VoiceInterviewReport }> {
  return apiGet<{ report: VoiceInterviewReport }>(`/voice-interviews/session/${id}/report`);
}

/** Company/recruiter: get voice interview report for an application. */
export async function getVoiceInterviewReportForApplication(
  applicationId: string
): Promise<{ report: VoiceInterviewReport }> {
  return apiGet<{ report: VoiceInterviewReport }>(`/voice-interviews/application/${applicationId}/report`);
}

export async function startVoiceInterview(
  id: string,
  options?: { preferredLanguage?: string }
): Promise<{
  session: { id: string; status: string; currentQuestionIndex: number; maxQuestions: number; currentQuestion: string; preferredLanguage?: string };
}> {
  return apiPost<{
    session: { id: string; status: string; currentQuestionIndex: number; maxQuestions: number; currentQuestion: string; preferredLanguage?: string };
  }>(`/voice-interviews/session/${id}/start`, options ? { preferredLanguage: options.preferredLanguage } : {});
}

export async function submitVoiceInterviewAnswer(
  id: string,
  answerText: string,
  options?: { expressionSummary?: string | null }
): Promise<
  | { done: true; message: string; session: { id: string; status: string } }
  | { done: false; session: { id: string; currentQuestionIndex: number; maxQuestions: number; currentQuestion: string } }
> {
  return apiPost<any>(`/voice-interviews/session/${id}/answer`, {
    answerText,
    expressionSummary: options?.expressionSummary ?? undefined,
  });
}

export async function assignVoiceInterview(
  applicationId: string,
  options?: { durationMinutes?: number }
): Promise<{
  message: string;
  session: {
    id: string;
    applicationId: string;
    jobId: string;
    status: string;
    maxQuestions: number;
    allocatedInterviewQuestions?: number;
    expiresAt: string;
  };
}> {
  return apiPost<{
    message: string;
    session: {
      id: string;
      applicationId: string;
      jobId: string;
      status: string;
      maxQuestions: number;
      allocatedInterviewQuestions?: number;
      expiresAt: string;
    };
  }>('/voice-interviews/assign', { applicationId, durationMinutes: options?.durationMinutes });
}

/** Whether Alibaba TTS is available (same key as Qwen). */
export async function getVoiceInterviewSpeechConfig(): Promise<{ useAlibabaTTS: boolean }> {
  return apiGet<{ useAlibabaTTS: boolean }>('/voice-interviews/speech-config');
}

/** Alibaba TTS: synthesize text to speech; returns audio blob (WAV). */
export async function synthesizeVoiceInterviewTTS(text: string, languageCode: string): Promise<Blob> {
  return apiPostBlob('/voice-interviews/tts', { text, languageCode });
}

// ==================== COMPANY JOB MANAGEMENT ====================
export async function getCompanyJobs(status?: string): Promise<Job[]> {
  const params = new URLSearchParams();
  if (status && status !== 'all') params.append('status', status);
  const query = params.toString();
  return apiGet<Job[]>(`/company/jobs${query ? `?${query}` : ''}`);
}

export async function getCompanyJob(id: string): Promise<Job> {
  return apiGet<Job>(`/company/jobs/${id}`);
}

/** Enriched matches for company job: includes appliedTo, bestFit, otherStrongFits per candidate. */
export async function getEnrichedMatchesForJob(jobId: string): Promise<EnrichedMatchResult[]> {
  return apiGet<EnrichedMatchResult[]>(`/company/jobs/${jobId}/matches`);
}

export interface EnrichedMatchResult {
  id: string;
  candidateId: string;
  jobId: string;
  score: number;
  breakdown?: any;
  explanation?: string;
  gaps?: any;
  status?: string;
  appliedTo: { jobId: string; jobTitle: string } | null;
  bestFit: { jobId: string; jobTitle: string; score: number } | null;
  otherStrongFits: { jobId: string; jobTitle: string; score: number }[];
  candidate?: any;
}

export async function canSendRoleSuggestion(candidateUserId: string): Promise<{ allowed: boolean; lastSentAt?: string }> {
  return apiGet<{ allowed: boolean; lastSentAt?: string }>(`/company/can-send-role-suggestion?candidateUserId=${encodeURIComponent(candidateUserId)}`);
}

export async function sendRoleSuggestion(data: {
  candidateUserId: string;
  jobId: string;
  suggestedJobId?: string;
  suggestedJobTitle?: string;
  templateType: 'better_fit' | 'both_roles';
  message?: string;
}): Promise<{ conversationId: string; sent: boolean }> {
  return apiPost<{ conversationId: string; sent: boolean }>('/company/send-role-suggestion', data);
}

export async function createCompanyJob(jobData: {
  title: string;
  department?: string;
  locationType?: string;
  country?: string;
  city?: string;
  description: string;
  mustHaveSkills?: string[];
  niceToHaveSkills?: string[];
  minYearsExperience?: number;
  seniorityLevel?: string;
  deadline?: string;
  status?: string;
}): Promise<Job> {
  return apiPost<Job>('/company/jobs', jobData);
}

export async function createCompanyJobFromUrl(
  url: string,
  status: 'draft' | 'published' = 'draft'
): Promise<Job> {
  return apiPost<Job>('/company/jobs/from-url', { url, status });
}

export async function updateCompanyJob(id: string, updates: Partial<Job>): Promise<Job> {
  return apiPut<Job>(`/company/jobs/${id}`, updates);
}

export async function deleteCompanyJob(id: string): Promise<{ message: string }> {
  return apiDelete<{ message: string }>(`/company/jobs/${id}`);
}

// ==================== PIPELINE (company) ====================
export async function getPipelineStages(): Promise<PipelineStage[]> {
  return apiGet<PipelineStage[]>('/pipeline/stages');
}

export async function createPipelineStage(data: { name: string; color?: string; order?: number }): Promise<PipelineStage> {
  return apiPost<PipelineStage>('/pipeline/stages', data);
}

export async function updatePipelineStage(id: string, data: { name?: string; color?: string; order?: number }): Promise<PipelineStage> {
  return apiPut<PipelineStage>(`/pipeline/stages/${id}`, data);
}

export async function deletePipelineStage(id: string): Promise<{ message: string }> {
  return apiDelete(`/pipeline/stages/${id}`) as Promise<{ message: string }>;
}

export async function reorderPipelineStages(stageIds: string[]): Promise<{ message: string }> {
  return apiPut<{ message: string }>('/pipeline/stages/reorder', { stageIds });
}

export async function getJobPipeline(jobId: string): Promise<JobPipeline> {
  return apiGet<JobPipeline>(`/pipeline/job/${jobId}`);
}

export async function moveApplicationInPipeline(applicationId: string, stageId: string, note?: string): Promise<any> {
  const body: any = { stageId };
  if (note) body.note = note;
  return apiPatch(`/pipeline/applications/${applicationId}/move`, body);
}

export async function getApplicationHistory(applicationId: string): Promise<ApplicationHistoryEntry[]> {
  return apiGet<ApplicationHistoryEntry[]>(`/pipeline/applications/${applicationId}/history`);
}

// ==================== NOTIFICATIONS ====================
export async function getNotifications(params?: {
  unreadOnly?: boolean;
  page?: number;
  limit?: number;
}): Promise<NotificationListResponse> {
  const qs = new URLSearchParams();
  if (params?.unreadOnly) qs.append('unreadOnly', 'true');
  if (params?.page) qs.append('page', params.page.toString());
  if (params?.limit) qs.append('limit', params.limit.toString());
  const query = qs.toString();
  return apiGet<NotificationListResponse>(`/notifications${query ? `?${query}` : ''}`);
}

export async function getUnreadNotificationCount(): Promise<{ unreadCount: number }> {
  return apiGet<{ unreadCount: number }>('/notifications/unread-count');
}

export async function markNotificationRead(id: string): Promise<{ message: string }> {
  return apiPatch<{ message: string }>(`/notifications/${id}/read`);
}

export async function markAllNotificationsRead(): Promise<{ message: string }> {
  return apiPatch<{ message: string }>('/notifications/read-all');
}

// ==================== CONVERSATIONS / MESSAGING ====================
export async function getConversations(): Promise<ConversationPreview[]> {
  return apiGet<ConversationPreview[]>('/conversations');
}

export async function getConversationMessages(conversationId: string, page?: number): Promise<MessagesResponse> {
  const params = new URLSearchParams();
  if (page) params.append('page', page.toString());
  const query = params.toString();
  return apiGet<MessagesResponse>(`/conversations/${conversationId}/messages${query ? `?${query}` : ''}`);
}

export async function sendMessage(conversationId: string, content: string): Promise<ChatMessage> {
  return apiPost<ChatMessage>(`/conversations/${conversationId}/messages`, { content });
}

export async function createConversation(data: {
  targetUserId?: string;
  candidateUserId?: string;
  jobId?: string;
  message?: string;
}): Promise<{ id: string; isNew: boolean }> {
  return apiPost<{ id: string; isNew: boolean }>('/conversations', data);
}

export async function getUnreadMessageCount(): Promise<{ unreadCount: number }> {
  return apiGet<{ unreadCount: number }>('/conversations/unread-count');
}

export interface MessageableUser {
  id: string;
  name: string;
  email: string;
  role: string;
  photoUrl: string | null;
  headline: string | null;
}

export async function searchUsersForMessaging(query: string, role?: string): Promise<MessageableUser[]> {
  const params = new URLSearchParams();
  if (query) params.append('q', query);
  if (role) params.append('role', role);
  const qs = params.toString();
  return apiGet<MessageableUser[]>(`/conversations/search-users${qs ? `?${qs}` : ''}`);
}

// ==================== SAVED JOBS ====================
export async function getSavedJobs(): Promise<SavedJobEntry[]> {
  return apiGet<SavedJobEntry[]>('/saved-jobs');
}

export async function saveJob(jobId: string): Promise<{ message: string }> {
  return apiPost<{ message: string }>('/saved-jobs', { jobId });
}

export async function unsaveJob(jobId: string): Promise<{ message: string }> {
  return apiDelete<{ message: string }>(`/saved-jobs/${jobId}`);
}

export async function isJobSaved(jobId: string): Promise<{ saved: boolean }> {
  return apiGet<{ saved: boolean }>(`/saved-jobs/${jobId}/check`);
}

// ==================== ANALYTICS ====================
export async function getCompanyAnalytics(): Promise<CompanyAnalytics> {
  return apiGet<CompanyAnalytics>('/analytics/company');
}

export async function getCandidateAnalytics(): Promise<CandidateAnalytics> {
  return apiGet<CandidateAnalytics>('/analytics/candidate');
}

export async function getAdminAnalytics(): Promise<AdminAnalytics> {
  return apiGet<AdminAnalytics>('/analytics/admin');
}

export async function getAdminUsage(): Promise<AdminUsage> {
  return apiGet<AdminUsage>('/analytics/admin/usage');
}

export async function getAdminCallStats(days?: number): Promise<AdminCallStats> {
  const params = days != null ? `?days=${days}` : '';
  return apiGet<AdminCallStats>(`/analytics/admin/call-stats${params}`);
}

// ==================== TEAM MANAGEMENT ====================
export async function getTeamMembers(): Promise<TeamMember[]> {
  return apiGet<TeamMember[]>('/company/members');
}

export async function inviteTeamMember(email: string, role?: MemberRole): Promise<{ id: string; email: string; role: string; status: string }> {
  return apiPost('/company/members/invite', { email, role: role || 'recruiter' });
}

export async function updateMemberRole(memberId: string, role: MemberRole): Promise<{ message: string }> {
  return apiPatch<{ message: string }>(`/company/members/${memberId}/role`, { role });
}

export async function removeTeamMember(memberId: string): Promise<{ message: string }> {
  return apiDelete<{ message: string }>(`/company/members/${memberId}`);
}

// ==================== PRIVACY SETTINGS ====================
export async function getPrivacySettings(): Promise<PrivacySettings> {
  return apiGet<PrivacySettings>('/candidate/profile/privacy');
}

export async function updatePrivacySettings(data: PrivacySettings): Promise<{ message: string }> {
  return apiPut<{ message: string }>('/candidate/profile/privacy', data);
}

// ==================== TOKEN REFRESH ====================
export async function refreshToken(): Promise<{ token: string }> {
  return apiPost<{ token: string }>('/auth/refresh');
}

// ==================== AI-POWERED FEATURES (Phase 6) ====================
import type {
  CvReviewResult,
  CvTailorResult,
  TailorCvReorderedResult,
  TailorResumeForJobResult,
  CoverLetterResult,
  CoverLetterTone,
  JobPostingReviewResult,
  GeneratedJobDescription,
  InterviewQuestionsResult,
  CandidateSummaryResult,
  SkillGapAnalysisResult,
  SalaryEstimateResult,
  AiChatResponse,
} from '@/types';

// 6.1 — CV Review
export async function reviewCv(targetRole?: string): Promise<CvReviewResult> {
  return apiPost<CvReviewResult>('/ai/cv-review', { targetRole });
}

/** Get full revised CV text: your uploaded CV with suggested bullet lines replaced. */
export async function getRevisedCvText(rewrittenBullets: { original: string; improved: string }[]): Promise<{ revisedCvText: string }> {
  return apiPost<{ revisedCvText: string }>('/ai/cv-review/revised-text', { rewrittenBullets });
}

/** Request improved CV as PDF (after AI CV Review). Returns blob to download. */
export async function exportCvReviewPdf(revisedCvText: string): Promise<Blob> {
  const url = `${API_BASE_URL}/ai/cv-review/export-pdf`;
  const token = localStorage.getItem('auth_token');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: 'include',
    body: JSON.stringify({ revisedCvText }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || 'Failed to generate PDF');
  }
  return res.blob();
}

// 6.2 — CV Tailor
export async function tailorCv(jobId: string): Promise<CvTailorResult> {
  return apiPost<CvTailorResult>('/ai/tailor-cv', { jobId });
}

/** Tailor CV for job: same content reordered (no fabrication). Returns tailoredCvText + keyChanges. */
export async function tailorCvReordered(jobId: string): Promise<TailorCvReorderedResult> {
  return apiPost<TailorCvReorderedResult>('/ai/tailor-cv/reordered', { jobId });
}

/** Tailor resume for job: apply suggestions + reorder for role. No fabrication. Saves to DB. */
export async function tailorResumeForJob(jobId: string): Promise<TailorResumeForJobResult> {
  return apiPost<TailorResumeForJobResult>('/ai/tailor-resume-for-job', { jobId });
}

/** Get saved tailored resume for this job (if any). Returns null on 404. */
export async function getTailoredResumeForJob(
  jobId: string
): Promise<{ tailoredCvText: string; structuredResume?: import('@/types').StructuredResume } | null> {
  try {
    return await apiGet<{ tailoredCvText: string; structuredResume?: import('@/types').StructuredResume }>(
      `/ai/tailor-resume-for-job/${encodeURIComponent(jobId)}`
    );
  } catch (_) {
    return null;
  }
}

/** Export tailored resume as PDF (template-based when structuredResume is provided). */
export async function exportTailoredResumePdf(
  tailoredCvText: string,
  structuredResume?: import('@/types').StructuredResume | null
): Promise<Blob> {
  const url = `${API_BASE_URL}/ai/tailor-resume-for-job/export-pdf`;
  const token = localStorage.getItem('auth_token');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ tailoredCvText, structuredResume: structuredResume ?? undefined }),
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || 'Export failed');
  }
  return res.blob();
}

// 6.3 — Cover Letter
export async function generateCoverLetter(
  jobId: string,
  tone?: CoverLetterTone
): Promise<CoverLetterResult> {
  return apiPost<CoverLetterResult>('/ai/cover-letter', { jobId, tone });
}

// ==================== SAVED COVER LETTERS ====================
export async function getSavedCoverLetters(): Promise<SavedCoverLetter[]> {
  return apiGet<SavedCoverLetter[]>('/cover-letters');
}

export async function getCoverLetterForJob(jobId: string): Promise<SavedCoverLetter | null> {
  return apiGet<SavedCoverLetter | null>(`/cover-letters/job/${jobId}`);
}

export async function saveCoverLetter(
  jobId: string,
  content: string,
  tone?: CoverLetterTone
): Promise<SavedCoverLetter & { message: string }> {
  return apiPost<SavedCoverLetter & { message: string }>('/cover-letters', { jobId, content, tone });
}

export async function updateCoverLetter(
  id: string,
  content: string,
  tone?: CoverLetterTone
): Promise<SavedCoverLetter & { message: string }> {
  return apiPut<SavedCoverLetter & { message: string }>(`/cover-letters/${id}`, { content, tone });
}

export async function deleteCoverLetter(id: string): Promise<{ message: string }> {
  return apiDelete<{ message: string }>(`/cover-letters/${id}`);
}

// 6.4 — Job Posting Review
export async function reviewJobPosting(data: {
  title: string;
  description: string;
  mustHaveSkills?: string[];
  niceToHaveSkills?: string[];
}): Promise<JobPostingReviewResult> {
  return apiPost<JobPostingReviewResult>('/ai/review-job-posting', data);
}

// 6.5 — Job Description Generator
export async function generateJobDescription(data: {
  title: string;
  skills?: string[];
  seniorityLevel?: string;
  locationType?: string;
  industry?: string;
}): Promise<GeneratedJobDescription> {
  return apiPost<GeneratedJobDescription>('/ai/generate-job-description', data);
}

// 6.6 — Interview Questions
export async function generateInterviewQuestions(data: {
  jobId: string;
  candidateId?: string;
  questionTypes?: string[];
  difficulty?: string;
}): Promise<InterviewQuestionsResult> {
  return apiPost<InterviewQuestionsResult>('/ai/interview-questions', data);
}

// 6.7 — Candidate Summary
export async function generateCandidateSummary(
  candidateId: string,
  jobId: string
): Promise<CandidateSummaryResult> {
  return apiPost<CandidateSummaryResult>('/ai/candidate-summary', { candidateId, jobId });
}

// 6.8 — Skill Gap Analysis
export async function analyzeSkillGaps(data: {
  targetRole?: string;
  targetJobIds?: string[];
}): Promise<SkillGapAnalysisResult> {
  return apiPost<SkillGapAnalysisResult>('/ai/skill-gap-analysis', data);
}

// 6.9 — Salary Estimator
export async function estimateSalary(data: {
  role: string;
  skills?: string[];
  yearsExperience?: number;
  country: string;
  city?: string;
}): Promise<SalaryEstimateResult> {
  return apiPost<SalaryEstimateResult>('/ai/salary-estimate', data);
}

// 6.10 — AI Chat
export async function aiChat(
  message: string,
  conversationHistory?: { role: 'user' | 'assistant'; content: string }[]
): Promise<AiChatResponse> {
  return apiPost<AiChatResponse>('/ai/chat', { message, conversationHistory });
}
