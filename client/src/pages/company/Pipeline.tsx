import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRoute, Link } from 'wouter';
import {
  getJobPipeline,
  moveApplicationInPipeline,
  getApplicationHistory,
  assignInterviewAssessment,
  assignVoiceInterview,
  getInterviewAssessmentsForApplication,
  getInterviewAssessmentReport,
  getVoiceInterviewReportForApplication,
  reissueInterviewAssessment,
} from '@/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScoreBadge } from '@/components/ScoreBadge';
import { useToast } from '@/hooks/use-toast';
import { formatDate, formatDateTime } from '@/utils/helpers';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  GripVertical,
  Users,
  Clock,
  ChevronRight,
  ChevronLeft,
  Search,
  Filter,
  History,
  Loader2,
  MessageCircleQuestion,
  RefreshCw,
  FileText,
  Mic,
  Download,
} from 'lucide-react';
import { voiceInterviewReportToPdfBlob } from '@/lib/pdfExport';
import type { PipelineColumn, PipelineApplication, ApplicationHistoryEntry } from '@/types';

export default function Pipeline() {
  const [, params] = useRoute('/company/jobs/:id/pipeline');
  const jobId = params?.id || '';
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [draggedApp, setDraggedApp] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const [moveNote, setMoveNote] = useState('');
  const [moveDialog, setMoveDialog] = useState<{
    applicationId: string;
    targetStageId: string;
    targetStageName: string;
    candidateName: string;
  } | null>(null);
  const [historyDialog, setHistoryDialog] = useState<string | null>(null);
  const [scoreFilter, setScoreFilter] = useState<number>(0);
  const [searchFilter, setSearchFilter] = useState('');
  const [assessmentDialogApp, setAssessmentDialogApp] = useState<PipelineApplication | null>(null);
  const [selectedAssessmentId, setSelectedAssessmentId] = useState<string | null>(null);
  const [voiceInterviewDuration, setVoiceInterviewDuration] = useState<number>(10);
  /** Technical/script question count chosen by recruiter (server adds intro turns). */
  const [voiceInterviewQuestionCount, setVoiceInterviewQuestionCount] = useState<number>(5);

  const { data: pipeline, isLoading } = useQuery({
    queryKey: ['job-pipeline', jobId],
    queryFn: () => getJobPipeline(jobId),
    enabled: !!jobId,
  });

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['app-history', historyDialog],
    queryFn: () => (historyDialog ? getApplicationHistory(historyDialog) : Promise.resolve([])),
    enabled: !!historyDialog,
  });

  const { data: assessmentData, isLoading: assessmentLoading } = useQuery({
    queryKey: ['interview-assessments-app', assessmentDialogApp?.id],
    queryFn: () => getInterviewAssessmentsForApplication(assessmentDialogApp!.id),
    enabled: !!assessmentDialogApp?.id,
  });

  const assessments = assessmentData?.assessments || [];
  const latestAssessment = assessments[0] || null;

  const { data: reportData, isLoading: reportLoading } = useQuery({
    queryKey: ['interview-report', selectedAssessmentId],
    queryFn: () => getInterviewAssessmentReport(selectedAssessmentId!),
    enabled: !!selectedAssessmentId,
  });

  const { data: voiceReportData, isLoading: voiceReportLoading } = useQuery({
    queryKey: ['voice-interview-report-app', assessmentDialogApp?.id],
    queryFn: () => getVoiceInterviewReportForApplication(assessmentDialogApp!.id),
    enabled: !!assessmentDialogApp?.id,
    retry: false,
  });

  const assignAssessmentMutation = useMutation({
    mutationFn: (applicationId: string) => assignInterviewAssessment(applicationId),
    onSuccess: () => {
      toast({ title: 'Assessment assigned' });
      queryClient.invalidateQueries({ queryKey: ['interview-assessments-app', assessmentDialogApp?.id] });
      queryClient.invalidateQueries({ queryKey: ['job-pipeline', jobId] });
    },
    onError: (error: any) => {
      toast({
        title: 'Assign failed',
        description: error.message || 'Could not assign assessment.',
        variant: 'destructive',
      });
    },
  });

  const reissueAssessmentMutation = useMutation({
    mutationFn: (assessmentId: string) => reissueInterviewAssessment(assessmentId),
    onSuccess: () => {
      toast({ title: 'Assessment reissued' });
      setSelectedAssessmentId(null);
      queryClient.invalidateQueries({ queryKey: ['interview-assessments-app', assessmentDialogApp?.id] });
      queryClient.invalidateQueries({ queryKey: ['job-pipeline', jobId] });
    },
    onError: (error: any) => {
      toast({
        title: 'Reissue failed',
        description: error.message || 'Could not reissue assessment.',
        variant: 'destructive',
      });
    },
  });

  const assignVoiceInterviewMutation = useMutation({
    mutationFn: ({
      applicationId,
      durationMinutes,
      interviewQuestionCount,
    }: {
      applicationId: string;
      durationMinutes?: number;
      interviewQuestionCount?: number;
    }) => assignVoiceInterview(applicationId, { durationMinutes, interviewQuestionCount }),
    onSuccess: (res, { applicationId }) => {
      queryClient.invalidateQueries({ queryKey: ['voice-interview-report-app', applicationId] });
      const n = res.session.allocatedInterviewQuestions;
      toast({
        title: 'Voice interview assigned',
        description:
          typeof n === 'number'
            ? `The candidate will have ${n} interview question${n === 1 ? '' : 's'} (plus intro). They can start from Interviews → Voice interviews.`
            : 'The candidate can complete the voice interview from their Interviews page.',
      });
      queryClient.invalidateQueries({ queryKey: ['job-pipeline', jobId] });
    },
    onError: (error: any) => {
      toast({
        title: 'Assign failed',
        description: error.message || 'Could not assign voice interview.',
        variant: 'destructive',
      });
    },
  });

  const moveMutation = useMutation({
    mutationFn: ({ applicationId, stageId, note }: {
      applicationId: string;
      stageId: string;
      note?: string;
    }) => moveApplicationInPipeline(applicationId, stageId, note),
    onSuccess: (data) => {
      toast({
        title: 'Application Moved',
        description: data.message || 'Application moved successfully.',
      });
      queryClient.invalidateQueries({ queryKey: ['job-pipeline', jobId] });
      setMoveDialog(null);
      setMoveNote('');
    },
    onError: (error: any) => {
      toast({
        title: 'Move Failed',
        description: error.message || 'Failed to move application.',
        variant: 'destructive',
      });
    },
  });

  // Drag handlers
  const handleDragStart = useCallback((e: React.DragEvent, applicationId: string) => {
    e.dataTransfer.setData('applicationId', applicationId);
    e.dataTransfer.effectAllowed = 'move';
    setDraggedApp(applicationId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, stageId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverStage(stageId);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverStage(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, stageId: string, stageName: string) => {
    e.preventDefault();
    setDragOverStage(null);
    setDraggedApp(null);

    const applicationId = e.dataTransfer.getData('applicationId');
    if (!applicationId) return;

    // Find the candidate name for the dialog
    let candidateName = 'Unknown Candidate';
    if (pipeline) {
      for (const stage of pipeline.stages) {
        const app = stage.applications.find(a => a.id === applicationId);
        if (app?.candidate?.name) {
          candidateName = app.candidate.name;
          break;
        }
      }
    }

    // Check if moving to the same stage
    const currentStage = pipeline?.stages.find(s =>
      s.applications.some(a => a.id === applicationId)
    );
    if (currentStage?.id === stageId) return;

    // Show confirmation dialog
    setMoveDialog({
      applicationId,
      targetStageId: stageId,
      targetStageName: stageName,
      candidateName,
    });
  }, [pipeline]);

  const handleMoveConfirm = () => {
    if (!moveDialog) return;
    moveMutation.mutate({
      applicationId: moveDialog.applicationId,
      stageId: moveDialog.targetStageId,
      note: moveNote || undefined,
    });
  };

  // Filter applications within stages
  const filterApplications = (apps: PipelineApplication[]): PipelineApplication[] => {
    return apps.filter(app => {
      if (scoreFilter > 0 && (app.matchScore === null || app.matchScore < scoreFilter)) {
        return false;
      }
      if (searchFilter) {
        const search = searchFilter.toLowerCase();
        const name = app.candidate?.name?.toLowerCase() || '';
        const email = app.candidate?.email?.toLowerCase() || '';
        const headline = app.candidate?.headline?.toLowerCase() || '';
        if (!name.includes(search) && !email.includes(search) && !headline.includes(search)) {
          return false;
        }
      }
      return true;
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="flex gap-4 overflow-x-auto pb-4">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <Skeleton key={i} className="h-96 w-72 flex-shrink-0" />
          ))}
        </div>
      </div>
    );
  }

  if (!pipeline) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <p className="text-muted-foreground">Pipeline not found</p>
        <Link href="/company/jobs">
          <Button variant="outline" className="mt-4">Back to Jobs</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-4">
          <Link href={`/company/jobs/${jobId}`}>
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-bold">{pipeline.job.title}</h1>
            <p className="text-sm text-muted-foreground">
              {pipeline.job.department} · {pipeline.totalApplications} application{pipeline.totalApplications !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="relative flex-grow max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search candidates..."
            className="pl-9"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <span className="text-muted-foreground">Min Score:</span>
          <Input
            type="number"
            className="w-20 h-8"
            value={scoreFilter || ''}
            onChange={(e) => setScoreFilter(parseInt(e.target.value) || 0)}
            min={0}
            max={100}
            placeholder="0"
          />
        </div>
      </div>

      {/* Kanban Board */}
      <div className="flex gap-4 overflow-x-auto pb-4 flex-1 min-h-0 custom-scrollbar">
        {pipeline.stages.map((stage) => {
          const filteredApps = filterApplications(stage.applications);
          const isDropTarget = dragOverStage === stage.id;

          return (
            <div
              key={stage.id}
              className={`flex flex-col w-72 flex-shrink-0 rounded-lg border transition-colors ${
                isDropTarget
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-muted/30'
              }`}
              onDragOver={(e) => handleDragOver(e, stage.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, stage.id, stage.name)}
            >
              {/* Stage Header */}
              <div
                className="flex items-center justify-between p-3 border-b rounded-t-lg"
                style={{ borderLeftColor: stage.color, borderLeftWidth: '4px' }}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{stage.name}</span>
                  <Badge variant="secondary" className="text-xs h-5">
                    {filteredApps.length}
                  </Badge>
                </div>
              </div>

              {/* Applications */}
              <div className="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar min-h-[200px]">
                {filteredApps.length === 0 ? (
                  <div className="flex items-center justify-center h-20 text-xs text-muted-foreground">
                    {stage.applications.length === 0 ? 'No applications' : 'No matches for filter'}
                  </div>
                ) : (
                  filteredApps.map((app) => (
                    <div
                      key={app.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, app.id)}
                      className={`rounded-md border bg-background p-3 cursor-grab active:cursor-grabbing transition-all hover:shadow-sm ${
                        draggedApp === app.id ? 'opacity-50 scale-95' : ''
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <Avatar className="w-8 h-8 flex-shrink-0">
                          <AvatarImage src={app.candidate?.photoUrl} />
                          <AvatarFallback className="text-xs">
                            {app.candidate?.name?.charAt(0) || '?'}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {app.candidate?.name || 'Unknown'}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {app.candidate?.headline || app.candidate?.email}
                          </p>
                        </div>
                        {app.matchScore !== null && (
                          <ScoreBadge score={app.matchScore} size="sm" />
                        )}
                      </div>

                      <div className="flex items-center justify-between mt-2">
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatDate(app.appliedAt)}
                        </span>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-1.5 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              setAssessmentDialogApp(app);
                              setSelectedAssessmentId(null);
                            }}
                          >
                            <MessageCircleQuestion className="w-3 h-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-1.5 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              setHistoryDialog(app.id);
                            }}
                          >
                            <History className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Move Confirmation Dialog */}
      <Dialog open={!!moveDialog} onOpenChange={(open) => !open && setMoveDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move Application</DialogTitle>
            <DialogDescription>
              Move <strong>{moveDialog?.candidateName}</strong> to{' '}
              <strong>{moveDialog?.targetStageName}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium">Add a note (optional)</label>
              <Textarea
                placeholder="e.g., Scheduled for Tuesday interview..."
                value={moveNote}
                onChange={(e) => setMoveNote(e.target.value)}
                rows={3}
                className="mt-1.5"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveDialog(null)}>
              Cancel
            </Button>
            <Button onClick={handleMoveConfirm} disabled={moveMutation.isPending}>
              {moveMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Moving...
                </>
              ) : (
                'Confirm Move'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* History Dialog */}
      <Dialog open={!!historyDialog} onOpenChange={(open) => !open && setHistoryDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Application History</DialogTitle>
            <DialogDescription>
              Timeline of status changes for this application
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 max-h-80 overflow-y-auto custom-scrollbar">
            {historyLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : !history || history.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No history entries yet
              </p>
            ) : (
              <div className="space-y-3">
                {history.map((entry) => (
                  <div key={entry.id} className="flex items-start gap-3 text-sm">
                    <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-xs capitalize">{entry.fromStatus}</Badge>
                        <ChevronRight className="w-3 h-3 text-muted-foreground" />
                        <Badge variant="default" className="text-xs capitalize">{entry.toStatus}</Badge>
                      </div>
                      {entry.note && (
                        <p className="text-xs text-muted-foreground mt-1 italic">"{entry.note}"</p>
                      )}
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                        <span>by {entry.changedBy?.name || 'Unknown'}</span>
                        <span>·</span>
                        <span>{formatDateTime(entry.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Interview Assessment Dialog */}
      <Dialog open={!!assessmentDialogApp} onOpenChange={(open) => !open && setAssessmentDialogApp(null)}>
        <DialogContent className="max-w-xl max-h-[90vh] flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>Interview Assessment</DialogTitle>
            <DialogDescription>
              {assessmentDialogApp?.candidate?.name || 'Candidate'} · application assessment controls
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 overflow-y-auto flex-1 min-h-0">
            {assessmentLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <>
                {!latestAssessment ? (
                  <div className="rounded-md border p-3 space-y-2">
                    <p className="text-sm text-muted-foreground">No assessment assigned yet.</p>
                    <Button
                      onClick={() => assessmentDialogApp && assignAssessmentMutation.mutate(assessmentDialogApp.id)}
                      disabled={assignAssessmentMutation.isPending}
                    >
                      {assignAssessmentMutation.isPending ? 'Assigning...' : 'Assign Assessment'}
                    </Button>
                  </div>
                ) : (
                  <div className="rounded-md border p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">Latest Assessment</p>
                      <Badge variant="outline" className="capitalize">
                        {latestAssessment.status.replace('_', ' ')}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Expires: {formatDateTime(latestAssessment.expiresAt)}
                    </p>

                    <div className="flex gap-2 flex-wrap">
                      {latestAssessment.status === 'expired' && (
                        <Button
                          variant="outline"
                          className="gap-2"
                          onClick={() => reissueAssessmentMutation.mutate(latestAssessment.id)}
                          disabled={reissueAssessmentMutation.isPending}
                        >
                          <RefreshCw className="w-4 h-4" />
                          {reissueAssessmentMutation.isPending ? 'Reissuing...' : 'Reissue'}
                        </Button>
                      )}
                      {latestAssessment.status === 'submitted' && (
                        <Button
                          variant="outline"
                          className="gap-2"
                          onClick={() => setSelectedAssessmentId(latestAssessment.id)}
                        >
                          <FileText className="w-4 h-4" />
                          View Report
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {selectedAssessmentId && (
                  <div className="rounded-md border p-3 space-y-2">
                    {reportLoading ? (
                      <Skeleton className="h-24 w-full" />
                    ) : !reportData?.report ? (
                      <p className="text-sm text-muted-foreground">Report not available.</p>
                    ) : (
                      <>
                        <p className="text-sm font-medium">Score: {Math.round(reportData.report.overallScore)}/100</p>
                        <p className="text-sm text-muted-foreground">{reportData.report.recommendation}</p>
                      </>
                    )}
                  </div>
                )}

                <div className="border-t pt-4 mt-4">
                  <p className="text-sm font-medium flex items-center gap-2 mb-1">
                    <Mic className="w-4 h-4" />
                    Voice interview
                  </p>
                  <p className="text-xs text-muted-foreground mb-2">
                    Assign a voice interview for this application. The candidate will see it under <strong>Interviews → Voice Interviews</strong>. You choose how many <strong>technical</strong> questions the AI asks; duration sets the session time limit. Intro turns are separate. Questions are generated from the job description and skills (Alibaba/Qwen).
                  </p>
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <label className="text-xs text-muted-foreground">Technical questions:</label>
                    <select
                      value={voiceInterviewQuestionCount}
                      onChange={(e) => setVoiceInterviewQuestionCount(Number(e.target.value))}
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    >
                      {[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <label className="text-xs text-muted-foreground">Session duration:</label>
                    <select
                      value={voiceInterviewDuration}
                      onChange={(e) => setVoiceInterviewDuration(Number(e.target.value))}
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value={5}>5 min</option>
                      <option value={10}>10 min</option>
                      <option value={15}>15 min</option>
                      <option value={20}>20 min</option>
                      <option value={30}>30 min</option>
                    </select>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() =>
                        assessmentDialogApp &&
                        assignVoiceInterviewMutation.mutate({
                          applicationId: assessmentDialogApp.id,
                          durationMinutes: voiceInterviewDuration,
                          interviewQuestionCount: voiceInterviewQuestionCount,
                        })
                      }
                      disabled={assignVoiceInterviewMutation.isPending}
                    >
                      {assignVoiceInterviewMutation.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Assigning...
                        </>
                      ) : (
                        <>
                          <Mic className="w-4 h-4" />
                          Assign voice interview
                        </>
                      )}
                    </Button>
                  </div>

                  {voiceReportLoading && <Skeleton className="h-20 w-full mt-3" />}
                  {!voiceReportLoading && voiceReportData?.report && (!voiceReportData.report.applicationId || voiceReportData.report.applicationId === assessmentDialogApp?.id) && (
                    <Card className="mt-3 border-primary/30 bg-primary/5">
                      <CardHeader className="py-3 flex flex-row items-start justify-between gap-2">
                        <div>
                          <CardTitle className="text-sm flex items-center gap-2">
                            <FileText className="w-4 h-4" />
                            Voice interview report
                          </CardTitle>
                          <CardDescription className="text-xs space-y-0.5">
                            {voiceReportData.report.completedAt && (
                              <span className="block">Completed {formatDateTime(voiceReportData.report.completedAt)}</span>
                            )}
                            {typeof voiceReportData.report.allocatedInterviewQuestions === 'number' && (
                              <span className="block text-foreground/90">
                                {voiceReportData.report.allocatedInterviewQuestions} technical question
                                {voiceReportData.report.allocatedInterviewQuestions === 1 ? '' : 's'} allocated
                                {typeof voiceReportData.report.maxInterviewTurns === 'number'
                                  ? ` · ${voiceReportData.report.maxInterviewTurns} max turns (including intro)`
                                  : ''}
                              </span>
                            )}
                          </CardDescription>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1 shrink-0"
                          onClick={() => {
                            const blob = voiceInterviewReportToPdfBlob(
                              {
                                jobTitle: voiceReportData.report.jobTitle,
                                completedAt: voiceReportData.report.completedAt,
                                outcome: voiceReportData.report.outcome,
                                qa: voiceReportData.report.qa || [],
                              },
                              assessmentDialogApp?.candidate?.name
                            );
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `voice-interview-report-${assessmentDialogApp?.candidate?.name?.replace(/\s+/g, '-') || 'candidate'}.pdf`;
                            a.click();
                            URL.revokeObjectURL(url);
                          }}
                        >
                          <Download className="w-3.5 h-3.5" />
                          Download PDF
                        </Button>
                      </CardHeader>
                      <CardContent className="py-2 space-y-4">
                        {voiceReportData.report.qa && voiceReportData.report.qa.length > 0 && (
                          <div className="space-y-2">
                            <p className="text-xs font-semibold text-foreground uppercase tracking-wide">Questions &amp; Answers</p>
                            <div className="max-h-48 overflow-y-auto rounded-md bg-muted/30 p-3 border border-border/50 space-y-3 text-sm">
                              {voiceReportData.report.qa.map((item, idx) => (
                                <div key={idx}>
                                  <p className="font-medium text-foreground/90">{item.question}</p>
                                  <p className="pl-2 border-l-2 border-primary/40 text-muted-foreground">{item.answer || '(No answer)'}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {voiceReportData.report.outcome ? (
                          <div className="space-y-2">
                            <p className="text-xs font-semibold text-foreground uppercase tracking-wide">Summary &amp; Analysis</p>
                            <div className="max-h-52 overflow-y-auto text-sm whitespace-pre-wrap rounded-md bg-muted/50 p-3 border border-border/50">
                              {voiceReportData.report.outcome.split(/\n+/).filter((p) => p.trim()).map((para, i) => (
                                <p key={i} className={i > 0 ? 'mt-2' : ''}>
                                  {para.trim()}
                                </p>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            Summary is being generated or could not be generated. You can still download the full Q&amp;A transcript as PDF below.
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  )}
                  {!voiceReportLoading && (!voiceReportData?.report || (voiceReportData.report.applicationId != null && voiceReportData.report.applicationId !== assessmentDialogApp?.id)) && (
                    <p className="text-xs text-muted-foreground mt-2">
                      {voiceReportData?.report && voiceReportData.report.applicationId != null && voiceReportData.report.applicationId !== assessmentDialogApp?.id
                        ? 'Loading this candidate’s report…'
                        : 'No voice interview report yet. Assign a voice interview above; the report will appear here once the candidate completes it.'}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
