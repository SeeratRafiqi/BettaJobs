import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRoute, Link, useLocation } from 'wouter';
import {
  getCompanyJob,
  getApplicationsForJob,
  updateApplicationStatus,
  updateCompanyJob,
  getEnrichedMatchesForJob,
  createConversation,
  deleteCompanyJob,
  canSendRoleSuggestion,
  sendRoleSuggestion,
  downloadApplicationResume,
} from '@/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { StatusChip } from '@/components/StatusChip';
import { ScoreBadge } from '@/components/ScoreBadge';
import { BreakdownBar } from '@/components/BreakdownBar';
import { JobMatrixView } from '@/components/MatrixView';
import { useToast } from '@/hooks/use-toast';
import { formatDate, getCountryFromCode } from '@/utils/helpers';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft,
  MapPin,
  Calendar,
  Briefcase,
  Users,
  FileText,
  CheckCircle2,
  XCircle,
  Clock,
  Eye,
  UserCheck,
  UserX,
  User,
  ChevronRight,
  Columns3,
  MessageSquare,
  Send,
  Loader2,
  Target,
  Trash2,
  Download,
} from 'lucide-react';
import type { Application, ApplicationStatus } from '@/types';

const applicationStatusOptions = [
  { value: 'all', label: 'All' },
  { value: 'applied', label: 'Applied' },
  { value: 'screening', label: 'Screening' },
  { value: 'interview', label: 'Interview' },
  { value: 'offer', label: 'Offer' },
  { value: 'hired', label: 'Hired' },
  { value: 'rejected', label: 'Rejected' },
];

const sortOptions = [
  { value: 'date', label: 'Newest First' },
  { value: 'score', label: 'Best Score' },
];

const statusFlow: ApplicationStatus[] = ['applied', 'screening', 'interview', 'offer', 'hired'];

const statusColors: Record<string, string> = {
  applied: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  screening: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  interview: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  offer: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  hired: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  rejected: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
};

export default function CompanyJobDetail() {
  const [, params] = useRoute('/company/jobs/:id');
  const jobId = params?.id || '';
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const [appStatusFilter, setAppStatusFilter] = useState('all');
  const [appSort, setAppSort] = useState('date');
  const [statusAction, setStatusAction] = useState<{ app: Application; newStatus: ApplicationStatus } | null>(null);
  const [selectedApp, setSelectedApp] = useState<Application | null>(null);
  const [resumeViewApp, setResumeViewApp] = useState<Application | null>(null);
  const [resumeDownloadingId, setResumeDownloadingId] = useState<string | null>(null);
  const [minScore, setMinScore] = useState(0);
  const [selectedMatch, setSelectedMatch] = useState<any>(null);
  const [messageDialog, setMessageDialog] = useState<{
    open: boolean;
    candidateUserId: string;
    candidateName: string;
  }>({ open: false, candidateUserId: '', candidateName: '' });
  const [messageText, setMessageText] = useState('');
  const [roleSuggestionDialog, setRoleSuggestionDialog] = useState<{
    open: boolean;
    candidateUserId: string;
    candidateName: string;
    suggestedJobId: string;
    suggestedJobTitle: string;
    templateType: 'better_fit' | 'both_roles';
    message: string;
  } | null>(null);

  const { data: job, isLoading: jobLoading } = useQuery({
    queryKey: ['company-job', jobId],
    queryFn: () => getCompanyJob(jobId),
    enabled: !!jobId,
  });

  const { data: applications, isLoading: appsLoading } = useQuery({
    queryKey: ['job-applications', jobId, appStatusFilter, appSort],
    queryFn: () =>
      getApplicationsForJob(jobId, {
        status: appStatusFilter !== 'all' ? appStatusFilter : undefined,
        sortBy: appSort,
      }),
    enabled: !!jobId,
  });

  // Fetch enriched matched candidates (includes appliedTo, bestFit, otherStrongFits)
  const { data: matchedCandidates, isLoading: matchesLoading } = useQuery({
    queryKey: ['enriched-matches-for-job', jobId],
    queryFn: () => getEnrichedMatchesForJob(jobId),
    enabled: !!jobId,
  });

  const filteredMatches = Array.isArray(matchedCandidates)
    ? matchedCandidates.filter((m: any) => m.score == null || m.score >= minScore)
    : [];

  // Message mutation
  const messageMutation = useMutation({
    mutationFn: () =>
      createConversation({
        candidateUserId: messageDialog.candidateUserId,
        jobId,
        message: messageText.trim(),
      }),
    onSuccess: () => {
      toast({ title: 'Message sent!', description: `Conversation started with ${messageDialog.candidateName}` });
      setMessageDialog({ open: false, candidateUserId: '', candidateName: '' });
      setMessageText('');
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      setLocation('/messages');
    },
    onError: (err: any) => {
      toast({ title: 'Failed to send', description: err.message, variant: 'destructive' });
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ApplicationStatus }) =>
      updateApplicationStatus(id, status),
    onSuccess: () => {
      toast({ title: 'Status Updated' });
      setStatusAction(null);
      queryClient.invalidateQueries({ queryKey: ['job-applications', jobId] });
      queryClient.invalidateQueries({ queryKey: ['company-job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['company-stats'] });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  const handleDownloadApplicationResume = async (app: Application) => {
    setResumeDownloadingId(app.id);
    try {
      const { blob, filename } = await downloadApplicationResume(app.id);
      const baseName = (app.candidate?.name || 'candidate').replace(/\s+/g, '-');
      const fallback =
        app.cvType === 'tailored'
          ? `${baseName}-tailored-resume.pdf`
          : app.cvFileName || `${baseName}-resume.pdf`;
      const downloadName = filename || fallback;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ title: 'Download failed', description: err?.message ?? 'Could not download resume', variant: 'destructive' });
    } finally {
      setResumeDownloadingId(null);
    }
  };

  const handleViewApplicationResume = async (app: Application) => {
    if (app.cvType === 'tailored' || !app.cvFileId) {
      setResumeViewApp(app);
      return;
    }
    setResumeDownloadingId(app.id);
    try {
      const { blob } = await downloadApplicationResume(app.id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err: any) {
      toast({ title: 'Could not open resume', description: err?.message ?? 'Try download instead', variant: 'destructive' });
    } finally {
      setResumeDownloadingId(null);
    }
  };

  const toggleJobStatus = useMutation({
    mutationFn: (newStatus: string) => updateCompanyJob(jobId, { status: newStatus as any }),
    onSuccess: () => {
      toast({ title: 'Job status updated' });
      queryClient.invalidateQueries({ queryKey: ['company-job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['company-jobs'] });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  const deleteJobMutation = useMutation({
    mutationFn: () => deleteCompanyJob(jobId),
    onSuccess: () => {
      toast({ title: 'Job deleted' });
      queryClient.invalidateQueries({ queryKey: ['company-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['company-stats'] });
      setLocation('/company/jobs');
    },
    onError: (error: any) => {
      toast({ title: 'Unable to delete job', description: error.message, variant: 'destructive' });
    },
  });

  const sendRoleSuggestionMutation = useMutation({
    mutationFn: (data: { candidateUserId: string; suggestedJobId?: string; suggestedJobTitle?: string; templateType: 'better_fit' | 'both_roles'; message?: string }) =>
      sendRoleSuggestion({ ...data, jobId }),
    onSuccess: () => {
      toast({ title: 'Role suggestion sent' });
      setRoleSuggestionDialog(null);
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (error: any) => {
      toast({ title: 'Failed to send', description: error.message, variant: 'destructive' });
    },
  });

  if (jobLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <p className="text-muted-foreground">Job not found</p>
        <Link href="/company/jobs">
          <Button variant="outline" className="mt-4">Back to Jobs</Button>
        </Link>
      </div>
    );
  }

  const getNextStatus = (currentStatus: ApplicationStatus): ApplicationStatus | null => {
    const idx = statusFlow.indexOf(currentStatus);
    if (idx >= 0 && idx < statusFlow.length - 1) return statusFlow[idx + 1];
    return null;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/company/jobs">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{job.title}</h1>
            <StatusChip status={job.status} />
          </div>
          <p className="text-muted-foreground">{job.department}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/company/jobs/${jobId}/pipeline`}>
            <Button variant="outline" className="gap-2">
              <Columns3 className="w-4 h-4" />
              Pipeline View
            </Button>
          </Link>
          {job.status === 'draft' && (
            <Button onClick={() => toggleJobStatus.mutate('published')} className="gap-2">
              <CheckCircle2 className="w-4 h-4" />
              Publish
            </Button>
          )}
          {job.status === 'published' && (
            <Button variant="outline" onClick={() => toggleJobStatus.mutate('closed')} className="gap-2">
              <XCircle className="w-4 h-4" />
              Close Job
            </Button>
          )}
          <Button
            variant="destructive"
            className="gap-2"
            disabled={deleteJobMutation.isPending}
            onClick={() => {
              const confirmed = window.confirm(
                'Delete this job permanently? This cannot be undone. Jobs with applications cannot be deleted.'
              );
              if (confirmed) {
                deleteJobMutation.mutate();
              }
            }}
          >
            <Trash2 className="w-4 h-4" />
            {deleteJobMutation.isPending ? 'Deleting...' : 'Delete Job'}
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">{job.totalApplications || 0}</p>
            <p className="text-xs text-muted-foreground">Total Applications</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-blue-600">{job.statusCounts?.applied || 0}</p>
            <p className="text-xs text-muted-foreground">New</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-amber-600">
              {(job.statusCounts?.screening || 0) + (job.statusCounts?.interview || 0)}
            </p>
            <p className="text-xs text-muted-foreground">In Progress</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-green-600">
              {(job.statusCounts?.offer || 0) + (job.statusCounts?.hired || 0)}
            </p>
            <p className="text-xs text-muted-foreground">Offers/Hired</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-red-600">{job.statusCounts?.rejected || 0}</p>
            <p className="text-xs text-muted-foreground">Rejected</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="applications">
        <TabsList>
          <TabsTrigger value="applications">
            Applications ({job.totalApplications || 0})
          </TabsTrigger>
          <TabsTrigger value="matches">
            Matched Candidates ({filteredMatches.length})
          </TabsTrigger>
          <TabsTrigger value="matrix">Job Matrix</TabsTrigger>
          <TabsTrigger value="details">Job Details</TabsTrigger>
        </TabsList>

        <TabsContent value="applications" className="space-y-4">
          {/* Application Filters */}
          <div className="flex items-center gap-3 pt-2">
            <Select value={appStatusFilter} onValueChange={setAppStatusFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                {applicationStatusOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={appSort} onValueChange={setAppSort}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                {sortOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Applications List */}
          {appsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
            </div>
          ) : !applications || applications.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <FileText className="w-10 h-10 text-muted-foreground mb-3" />
                <p className="text-muted-foreground">
                  {appStatusFilter !== 'all'
                    ? `No ${appStatusFilter} applications`
                    : 'No applications yet'}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {applications.map((app) => {
                const nextStatus = getNextStatus(app.status as ApplicationStatus);
                return (
                  <Card key={app.id}>
                    <CardContent className="p-4">
                      <div className="flex items-start gap-4">
                        {/* Avatar */}
                        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                          {app.candidate?.photoUrl ? (
                            <img
                              src={app.candidate.photoUrl}
                              alt=""
                              className="w-10 h-10 rounded-full object-cover"
                            />
                          ) : (
                            <User className="w-5 h-5 text-muted-foreground" />
                          )}
                        </div>

                        {/* Candidate info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <h3
                                className="font-medium cursor-pointer hover:text-primary"
                                onClick={() => setSelectedApp(app)}
                              >
                                {app.candidate?.name || 'Unknown'}
                              </h3>
                              <p className="text-sm text-muted-foreground">
                                {app.candidate?.headline || app.candidate?.email}
                              </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {app.matchScore != null && (
                                <ScoreBadge score={app.matchScore} size="sm" />
                              )}
                              <Badge className={`${statusColors[app.status] || ''}`}>
                                {app.status}
                              </Badge>
                            </div>
                          </div>

                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            {app.candidate?.country && (
                              <span className="flex items-center gap-1">
                                <MapPin className="w-3 h-3" />
                                {app.candidate.country}
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              Applied {formatDate(app.appliedAt)}
                            </span>
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-2 mt-3">
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1"
                              onClick={() => setSelectedApp(app)}
                            >
                              <Eye className="w-3.5 h-3.5" />
                              View
                            </Button>
                            {nextStatus && (
                              <Button
                                size="sm"
                                className="gap-1"
                                onClick={() =>
                                  setStatusAction({ app, newStatus: nextStatus })
                                }
                              >
                                <UserCheck className="w-3.5 h-3.5" />
                                Move to {nextStatus}
                              </Button>
                            )}
                            {app.status !== 'rejected' && app.status !== 'hired' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive gap-1"
                                onClick={() =>
                                  setStatusAction({ app, newStatus: 'rejected' })
                                }
                              >
                                <UserX className="w-3.5 h-3.5" />
                                Reject
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ==================== MATCHED CANDIDATES TAB ==================== */}
        <TabsContent value="matches" className="space-y-4 pt-2">
          {/* Filters */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Min Score:</span>
              <div className="w-24">
                <Slider
                  value={[minScore]}
                  onValueChange={([v]) => setMinScore(v)}
                  max={100}
                  step={10}
                />
              </div>
              <span className="text-xs font-medium w-6">{minScore}</span>
            </div>
            <span className="text-sm text-muted-foreground">
              {filteredMatches.length} candidate{filteredMatches.length !== 1 ? 's' : ''}
            </span>
          </div>

          {matchesLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
            </div>
          ) : filteredMatches.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Users className="w-10 h-10 text-muted-foreground mb-3" />
                <p className="font-medium">No matched candidates yet</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Candidates will appear here as they upload CVs and get matched to this job.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {filteredMatches.map((match: any) => {
                const c = match.candidate;
                if (!c) return null;
                return (
                  <Card key={match.id} className="hover:bg-muted/30 transition-colors">
                    <CardContent className="p-4">
                      <div className="flex items-start gap-4">
                        {/* Avatar */}
                        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0 overflow-hidden">
                          {c.photoUrl ? (
                            <img src={c.photoUrl} alt="" className="w-10 h-10 rounded-full object-cover" />
                          ) : (
                            <User className="w-5 h-5 text-muted-foreground" />
                          )}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <h3
                                className="font-medium cursor-pointer hover:text-primary"
                                onClick={() => setSelectedMatch(match)}
                              >
                                {c.name}
                              </h3>
                              <p className="text-sm text-muted-foreground truncate">
                                {c.headline || c.roles?.[0] || c.email}
                              </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {match.score != null ? (
                                <ScoreBadge score={match.score} size="sm" />
                              ) : (
                                <span className="text-xs text-muted-foreground font-medium">Not scored</span>
                              )}
                              <StatusChip status={match.status} />
                            </div>
                          </div>

                          {/* Quick info */}
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            {c.country && (
                              <span className="flex items-center gap-0.5">
                                <MapPin className="w-3 h-3" />
                                {getCountryFromCode(c.countryCode || c.country)}
                              </span>
                            )}
                            {c.totalYearsExperience > 0 && (
                              <span className="flex items-center gap-0.5">
                                <Briefcase className="w-3 h-3" />
                                {c.totalYearsExperience}y exp
                              </span>
                            )}
                          </div>

                          {/* Applied to / Best fit */}
                          <div className="flex flex-wrap gap-2 mt-2 text-xs">
                            {match.appliedTo && (
                              <span className="text-muted-foreground">
                                Applied to: <strong className="text-foreground">{match.appliedTo.jobTitle}</strong>
                              </span>
                            )}
                            {match.bestFit && (
                              <span className="text-muted-foreground inline-flex items-center gap-1">
                                Best fit: <strong className="text-foreground">{match.bestFit.jobTitle}</strong>
                                {match.bestFit.score != null && (
                                  <ScoreBadge score={match.bestFit.score} size="sm" />
                                )}
                              </span>
                            )}
                            {match.otherStrongFits && match.otherStrongFits.length > 0 && (
                              <span className="text-muted-foreground">
                                Strong fit: {match.otherStrongFits.map((s: any) => s.jobTitle).join(', ')}
                              </span>
                            )}
                          </div>

                          {/* Skills preview */}
                          {c.skills && c.skills.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {c.skills.slice(0, 6).map((s: any, i: number) => (
                                <Badge key={i} variant="secondary" className="text-xs">
                                  {s.name}
                                </Badge>
                              ))}
                              {c.skills.length > 6 && (
                                <Badge variant="outline" className="text-xs">
                                  +{c.skills.length - 6} more
                                </Badge>
                              )}
                            </div>
                          )}

                          {/* Actions */}
                          <div className="flex flex-wrap items-center gap-2 mt-3">
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1"
                              onClick={() => setSelectedMatch(match)}
                            >
                              <Eye className="w-3.5 h-3.5" />
                              Details
                            </Button>
                            <Link href={`/company/candidates/${c.id}?job=${jobId}`}>
                              <Button variant="outline" size="sm" className="gap-1">
                                <User className="w-3.5 h-3.5" />
                                Full Profile
                              </Button>
                            </Link>
                            {c.userId && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1"
                                onClick={() =>
                                  setMessageDialog({
                                    open: true,
                                    candidateUserId: c.userId,
                                    candidateName: c.name,
                                  })
                                }
                              >
                                <MessageSquare className="w-3.5 h-3.5" />
                                Message
                              </Button>
                            )}
                            {c.userId && match.bestFit && match.bestFit.jobId !== jobId && (
                              <Button
                                variant="default"
                                size="sm"
                                className="gap-1"
                                onClick={async () => {
                                  const { allowed } = await canSendRoleSuggestion(c.userId);
                                  if (!allowed) {
                                    toast({ title: 'Already sent', description: 'A role suggestion was sent to this candidate in the last 7 days.', variant: 'destructive' });
                                    return;
                                  }
                                  const msg = `Hi ${c.name}, we noticed your profile is a strong fit for our ${match.bestFit.jobTitle} role. Would you be open to us considering you for that position as well? Best, The team`;
                                  setRoleSuggestionDialog({
                                    open: true,
                                    candidateUserId: c.userId,
                                    candidateName: c.name,
                                    suggestedJobId: match.bestFit.jobId,
                                    suggestedJobTitle: match.bestFit.jobTitle,
                                    templateType: 'better_fit',
                                    message: msg,
                                  });
                                }}
                              >
                                Suggest role (better fit)
                              </Button>
                            )}
                            {c.userId && match.otherStrongFits?.length > 0 && match.appliedTo?.jobId === jobId && (
                              <Button
                                variant="default"
                                size="sm"
                                className="gap-1"
                                onClick={async () => {
                                  const { allowed } = await canSendRoleSuggestion(c.userId);
                                  if (!allowed) {
                                    toast({ title: 'Already sent', description: 'A role suggestion was sent to this candidate in the last 7 days.', variant: 'destructive' });
                                    return;
                                  }
                                  const other = match.otherStrongFits[0];
                                  const msg = `Hi ${c.name}, your background fits well with both our ${job.title} and ${other.jobTitle} openings. You applied for ${job.title}; we're happy to consider you for either. Would you like to be considered for both, or keep your application to ${job.title} only? Best, The team`;
                                  setRoleSuggestionDialog({
                                    open: true,
                                    candidateUserId: c.userId,
                                    candidateName: c.name,
                                    suggestedJobId: other.jobId,
                                    suggestedJobTitle: other.jobTitle,
                                    templateType: 'both_roles',
                                    message: msg,
                                  });
                                }}
                              >
                                Suggest role (fits both)
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ==================== JOB MATRIX TAB ==================== */}
        <TabsContent value="matrix" className="space-y-4 pt-2">
          {job.matrix ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Target className="w-5 h-5" />
                  Job Matrix
                </CardTitle>
                <CardDescription>
                  AI-generated matrix used to evaluate and rank candidates for this position
                </CardDescription>
              </CardHeader>
              <CardContent>
                <JobMatrixView matrix={job.matrix} />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Target className="w-10 h-10 text-muted-foreground mb-3" />
                <p className="font-medium">No matrix generated yet</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {job.status === 'draft'
                    ? 'Publish this job to automatically generate a job matrix.'
                    : 'The matrix will be generated automatically. Please check back shortly.'}
                </p>
                {job.status === 'draft' && (
                  <Button
                    className="mt-4 gap-2"
                    onClick={() => toggleJobStatus.mutate('published')}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    Publish Job
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="details" className="space-y-4 pt-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Job Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-muted-foreground" />
                  <span>{job.city ? `${job.city}, ` : ''}{getCountryFromCode(job.country)}</span>
                  <Badge variant="outline" className="capitalize ml-1">{job.locationType}</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <Briefcase className="w-4 h-4 text-muted-foreground" />
                  <span className="capitalize">{job.seniorityLevel} level</span>
                </div>
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-muted-foreground" />
                  <span>{job.minYearsExperience}+ years experience</span>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-muted-foreground" />
                  <span>Posted {formatDate(job.createdAt)}</span>
                </div>
                {job.deadline && (
                  <div className="flex items-center gap-2 text-amber-600">
                    <Clock className="w-4 h-4" />
                    <span>Deadline: {formatDate(job.deadline)}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Description</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">
                {job.description}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Skills</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-sm font-medium mb-2">Must-Have</p>
                <div className="flex flex-wrap gap-2">
                  {job.mustHaveSkills?.map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </div>
              </div>
              {job.niceToHaveSkills && job.niceToHaveSkills.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2">Nice-to-Have</p>
                  <div className="flex flex-wrap gap-2">
                    {job.niceToHaveSkills.map((s) => (
                      <Badge key={s} variant="secondary">{s}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Application Detail Drawer / Dialog */}
      <Dialog open={!!selectedApp} onOpenChange={() => setSelectedApp(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{selectedApp?.candidate?.name}</DialogTitle>
            <DialogDescription>{selectedApp?.candidate?.headline || selectedApp?.candidate?.email}</DialogDescription>
          </DialogHeader>
          {selectedApp && (
            <div className="space-y-4 py-2">
              <div className="flex items-center gap-3">
                <Badge className={statusColors[selectedApp.status] || ''}>
                  {selectedApp.status}
                </Badge>
                {selectedApp.matchScore != null && (
                  <ScoreBadge score={selectedApp.matchScore} size="sm" showLabel />
                )}
                <span className="text-sm text-muted-foreground ml-auto">
                  Applied {formatDate(selectedApp.appliedAt)}
                </span>
              </div>

              {selectedApp.candidate && (
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {selectedApp.candidate.email && (
                    <div><span className="text-muted-foreground">Email:</span> {selectedApp.candidate.email}</div>
                  )}
                  {selectedApp.candidate.phone && (
                    <div><span className="text-muted-foreground">Phone:</span> {selectedApp.candidate.phone}</div>
                  )}
                  {selectedApp.candidate.country && (
                    <div><span className="text-muted-foreground">Country:</span> {selectedApp.candidate.country}</div>
                  )}
                </div>
              )}

              {(selectedApp.submittedCvText?.trim() || selectedApp.cvFileId) && (
                <div className="rounded-lg border border-border bg-muted/40 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <FileText className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Resume</p>
                        <p className="text-xs text-muted-foreground">
                          {selectedApp.cvType === 'tailored'
                            ? 'Tailored CV — downloads as PDF in the same template used at apply time'
                            : selectedApp.cvFileName
                              ? `Original uploaded file · ${selectedApp.cvFileName}`
                              : 'Original CV file submitted with this application'}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 shrink-0">
                      {selectedApp.submittedCvText?.trim() && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={() => handleViewApplicationResume(selectedApp)}
                        >
                          <Eye className="h-4 w-4" />
                          {selectedApp.cvType === 'tailored' || !selectedApp.cvFileId ? 'View text' : 'View PDF'}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        className="gap-1.5"
                        disabled={resumeDownloadingId === selectedApp.id}
                        onClick={() => handleDownloadApplicationResume(selectedApp)}
                      >
                        {resumeDownloadingId === selectedApp.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Download className="h-4 w-4" />
                        )}
                        Download PDF
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {selectedApp.coverLetter && (
                <div>
                  <p className="text-sm font-medium mb-1">Cover Letter</p>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap bg-muted p-3 rounded-md">
                    {selectedApp.coverLetter}
                  </p>
                </div>
              )}

              {selectedApp.matchExplanation && (
                <div>
                  <p className="text-sm font-medium mb-1">AI Match Analysis</p>
                  <p className="text-sm text-muted-foreground">{selectedApp.matchExplanation}</p>
                </div>
              )}

              {selectedApp.matchGaps && selectedApp.matchGaps.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-1">Gaps</p>
                  <div className="space-y-1">
                    {selectedApp.matchGaps.map((g, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm p-2 bg-amber-50 dark:bg-amber-900/20 rounded">
                        <Badge variant="outline" className="text-xs capitalize shrink-0">{g.severity}</Badge>
                        <span>{g.description}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2">
            {selectedApp && selectedApp.status !== 'rejected' && selectedApp.status !== 'hired' && (
              <>
                {getNextStatus(selectedApp.status as ApplicationStatus) && (
                  <Button
                    onClick={() =>
                      setStatusAction({
                        app: selectedApp,
                        newStatus: getNextStatus(selectedApp.status as ApplicationStatus)!,
                      })
                    }
                    className="gap-1"
                  >
                    <ChevronRight className="w-4 h-4" />
                    Move to {getNextStatus(selectedApp.status as ApplicationStatus)}
                  </Button>
                )}
                <Button
                  variant="destructive"
                  onClick={() =>
                    setStatusAction({ app: selectedApp, newStatus: 'rejected' })
                  }
                >
                  Reject
                </Button>
              </>
            )}
            <Button variant="outline" onClick={() => setSelectedApp(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resume preview (application modal) */}
      <Dialog open={!!resumeViewApp} onOpenChange={(open) => !open && setResumeViewApp(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Resume — {resumeViewApp?.candidate?.name}</DialogTitle>
            <DialogDescription>
              {resumeViewApp?.cvType === 'tailored'
                ? 'Tailored CV text submitted with this application'
                : 'CV text snapshot from when they applied'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto rounded-md border bg-muted/30 p-4 text-sm whitespace-pre-wrap leading-relaxed">
            {resumeViewApp?.submittedCvText?.trim() || 'No resume text available.'}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            {resumeViewApp && (
              <Button
                type="button"
                variant="outline"
                className="gap-1.5"
                disabled={resumeDownloadingId === resumeViewApp.id}
                onClick={() => resumeViewApp && handleDownloadApplicationResume(resumeViewApp)}
              >
                {resumeDownloadingId === resumeViewApp.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                Download file
              </Button>
            )}
            <Button variant="outline" onClick={() => setResumeViewApp(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Status Change Confirmation */}
      <Dialog open={!!statusAction} onOpenChange={() => setStatusAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {statusAction?.newStatus === 'rejected'
                ? 'Reject Application?'
                : `Move to ${statusAction?.newStatus}?`}
            </DialogTitle>
            <DialogDescription>
              {statusAction?.newStatus === 'rejected'
                ? `Are you sure you want to reject ${statusAction?.app.candidate?.name}'s application?`
                : `Move ${statusAction?.app.candidate?.name}'s application to "${statusAction?.newStatus}" stage?`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStatusAction(null)}>
              Cancel
            </Button>
            <Button
              variant={statusAction?.newStatus === 'rejected' ? 'destructive' : 'default'}
              onClick={() =>
                statusAction &&
                updateStatusMutation.mutate({
                  id: statusAction.app.id,
                  status: statusAction.newStatus,
                })
              }
              disabled={updateStatusMutation.isPending}
            >
              {updateStatusMutation.isPending ? 'Updating...' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Match Detail Dialog */}
      <Dialog open={!!selectedMatch} onOpenChange={() => setSelectedMatch(null)}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selectedMatch?.candidate?.name}</DialogTitle>
            <DialogDescription>
              {selectedMatch?.candidate?.headline || selectedMatch?.candidate?.email}
            </DialogDescription>
          </DialogHeader>
          {selectedMatch && (
            <div className="space-y-4 py-2">
              <div className="flex items-center gap-3">
                {selectedMatch.score != null ? (
                  <ScoreBadge score={selectedMatch.score} size="md" showLabel />
                ) : (
                  <span className="text-sm text-muted-foreground font-medium">Not scored yet</span>
                )}
                <StatusChip status={selectedMatch.status} />
              </div>

              {/* Match Breakdown */}
              {selectedMatch.breakdown && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Score Breakdown</h4>
                  <BreakdownBar breakdown={selectedMatch.breakdown} />
                </div>
              )}

              {/* Explanation */}
              {selectedMatch.explanation && (
                <div>
                  <h4 className="text-sm font-medium mb-1">AI Match Analysis</h4>
                  <p className="text-sm text-muted-foreground">{selectedMatch.explanation}</p>
                </div>
              )}

              {/* Gaps */}
              {selectedMatch.gaps && selectedMatch.gaps.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-1">Gaps</h4>
                  <div className="space-y-1.5">
                    {selectedMatch.gaps.map((g: any, i: number) => (
                      <div key={i} className="flex items-start gap-2 text-sm p-2 bg-amber-50 dark:bg-amber-900/20 rounded">
                        <Badge variant="outline" className="text-xs capitalize shrink-0">{g.severity}</Badge>
                        <span>{g.description}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Skills */}
              {selectedMatch.candidate?.skills && selectedMatch.candidate.skills.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-1.5">Skills</h4>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedMatch.candidate.skills.map((s: any, i: number) => (
                      <Badge
                        key={i}
                        variant={s.level === 'advanced' ? 'default' : 'secondary'}
                        className="text-xs"
                      >
                        {s.name}
                        {s.yearsOfExperience > 0 && <span className="ml-1 opacity-70">{s.yearsOfExperience}y</span>}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Domains */}
              {selectedMatch.candidate?.domains && selectedMatch.candidate.domains.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-1.5">Domains</h4>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedMatch.candidate.domains.map((d: string, i: number) => (
                      <Badge key={i} variant="outline" className="text-xs">{d}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2">
            {selectedMatch?.candidate?.id && (
              <Link href={`/company/candidates/${selectedMatch.candidate.id}?job=${jobId}`}>
                <Button variant="outline" className="gap-1">
                  <User className="w-3.5 h-3.5" />
                  Full Profile
                </Button>
              </Link>
            )}
            {selectedMatch?.candidate?.userId && (
              <Button
                className="gap-1"
                onClick={() => {
                  setSelectedMatch(null);
                  setMessageDialog({
                    open: true,
                    candidateUserId: selectedMatch.candidate.userId,
                    candidateName: selectedMatch.candidate.name,
                  });
                }}
              >
                <MessageSquare className="w-3.5 h-3.5" />
                Message
              </Button>
            )}
            <Button variant="outline" onClick={() => setSelectedMatch(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Message Dialog */}
      <Dialog
        open={messageDialog.open}
        onOpenChange={(open) => {
          setMessageDialog((prev) => ({ ...prev, open }));
          if (!open) setMessageText('');
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Message {messageDialog.candidateName}</DialogTitle>
            <DialogDescription>
              Regarding: {job.title}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Textarea
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder="Hi! We reviewed your profile and think you'd be a great fit…"
              rows={5}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMessageDialog((prev) => ({ ...prev, open: false }))}
            >
              Cancel
            </Button>
            <Button
              onClick={() => messageMutation.mutate()}
              disabled={messageMutation.isPending || !messageText.trim()}
              className="gap-2"
            >
              {messageMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              Send Message
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Role suggestion dialog (pre-defined templates, throttle 7 days) */}
      <Dialog
        open={!!roleSuggestionDialog}
        onOpenChange={(open) => !open && setRoleSuggestionDialog(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Suggest role</DialogTitle>
            <DialogDescription>
              Send a message to {roleSuggestionDialog?.candidateName} about the {roleSuggestionDialog?.templateType === 'both_roles' ? 'other' : ''} role. You can edit the message below. Only one role suggestion per candidate per 7 days.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Textarea
              value={roleSuggestionDialog?.message ?? ''}
              onChange={(e) =>
                setRoleSuggestionDialog((prev) => (prev ? { ...prev, message: e.target.value } : null))
              }
              rows={6}
              className="resize-none"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleSuggestionDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                roleSuggestionDialog &&
                sendRoleSuggestionMutation.mutate({
                  candidateUserId: roleSuggestionDialog.candidateUserId,
                  suggestedJobId: roleSuggestionDialog.suggestedJobId,
                  suggestedJobTitle: roleSuggestionDialog.suggestedJobTitle,
                  templateType: roleSuggestionDialog.templateType,
                  message: roleSuggestionDialog.message,
                })
              }
              disabled={!roleSuggestionDialog?.message?.trim() || sendRoleSuggestionMutation.isPending}
              className="gap-2"
            >
              {sendRoleSuggestionMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              Send suggestion
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
