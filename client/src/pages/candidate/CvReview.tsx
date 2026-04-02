import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { reviewCv, getRecommendedJobs, getCandidateProfile, getJobPublic, tailorResumeForJob, exportTailoredResumePdf } from '@/api';
import { buildResumeHTMLTemplate, populateResumeTemplate } from '@/lib/resumeTemplate';
import { useAuthStore } from '@/store/auth';
import type { CvReviewResult, TailoredStructuredResume } from '@/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ScoreBadge } from '@/components/ScoreBadge';
import {
  Sparkles,
  FileSearch,
  AlertTriangle,
  CheckCircle2,
  Lightbulb,
  Loader2,
  Briefcase,
  MapPin,
  Download,
  FileCode2,
} from 'lucide-react';
import { Link } from 'wouter';
import { getCountryFromCode } from '@/utils/helpers';

export default function CvReview() {
  const { toast } = useToast();
  const { user } = useAuthStore();
  const [targetRole, setTargetRole] = useState('');
  const [selectedJobId, setSelectedJobId] = useState('');
  const [result, setResult] = useState<CvReviewResult | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [htmlLoading, setHtmlLoading] = useState(false);
  const [tailoredCvText, setTailoredCvText] = useState<string | null>(null);
  const [tailorKeyChanges, setTailorKeyChanges] = useState<string[]>([]);
  const [tailorJobTitle, setTailorJobTitle] = useState('');
  const [structuredResume, setStructuredResume] = useState<TailoredStructuredResume | null>(null);

  const jobIdFromUrl = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('jobId') : null;

  const { data: jobForTailor } = useQuery({
    queryKey: ['job-public', jobIdFromUrl],
    queryFn: () => getJobPublic(jobIdFromUrl!),
    enabled: !!jobIdFromUrl,
  });

  useEffect(() => {
    if (jobForTailor && jobIdFromUrl) {
      setSelectedJobId(jobIdFromUrl);
      setTargetRole(jobForTailor.title);
    }
  }, [jobForTailor?.title, jobIdFromUrl]);

  const tailorMutation = useMutation({
    mutationFn: () => tailorResumeForJob(jobIdFromUrl!),
    onSuccess: (data) => {
      setTailoredCvText(data.tailoredCvText);
      setTailorKeyChanges(data.keyChanges || []);
      setTailorJobTitle(data.jobTitle || '');
      setStructuredResume(data.structuredResume ?? null);
      toast({ title: 'Tailored resume ready', description: 'Review the formatted preview below and download when ready.' });
    },
    onError: (err: any) => {
      toast({ title: 'Tailoring failed', description: err?.message || 'Please try again.', variant: 'destructive' });
    },
  });

  // Get candidate profile
  const { data: profile } = useQuery({
    queryKey: ['candidate-profile'],
    queryFn: getCandidateProfile,
  });

  const candidateId = user?.candidateId || profile?.id;

  // Fetch matched jobs
  const { data: matchedJobs, isLoading: jobsLoading } = useQuery({
    queryKey: ['candidate-recommended-jobs', candidateId],
    queryFn: () => (candidateId ? getRecommendedJobs(candidateId) : Promise.resolve([])),
    enabled: !!candidateId,
  });

  const availableJobs = (matchedJobs || [])
    .filter((m) => m.job)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .map((m) => ({
      id: m.job!.id,
      title: m.job!.title,
      company: (m.job as any)?.company || '',
      department: (m.job as any)?.department || '',
      score: m.score,
      country: (m.job as any)?.country || '',
      city: (m.job as any)?.city || '',
      seniorityLevel: (m.job as any)?.seniorityLevel || '',
    }));

  // When a job is selected, set targetRole from job title
  const handleJobSelect = (jobId: string) => {
    setSelectedJobId(jobId);
    const job = availableJobs.find((j) => j.id === jobId);
    if (job) {
      setTargetRole(job.title);
    }
  };

  const mutation = useMutation({
    mutationFn: () => reviewCv(targetRole || undefined),
    onSuccess: (data) => {
      setResult(data);
      const isFallback = data.score === 0 && (data.summary?.includes('API key') || data.summary?.includes('not available'));
      toast({
        title: isFallback ? 'AI Review Unavailable' : 'CV Review Complete',
        description: isFallback ? 'Set ALIBABA_LLM_API_KEY in .env to enable AI review.' : `Your CV scored ${data.score}/100`,
      });
    },
    onError: (err: any) => {
      toast({ title: 'Review Failed', description: err.message, variant: 'destructive' });
    },
  });

  const scoreColor = (score: number) => {
    if (score >= 80) return 'text-green-600';
    if (score >= 60) return 'text-yellow-600';
    return 'text-red-600';
  };

  const scoreLabel = (score: number) => {
    if (score >= 80) return 'Excellent';
    if (score >= 60) return 'Good';
    if (score >= 40) return 'Needs Improvement';
    return 'Poor';
  };

  const selectedJob = availableJobs.find((j) => j.id === selectedJobId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <FileSearch className="w-6 h-6 text-primary" />
          AI CV Review
        </h1>
        <p className="text-muted-foreground mt-1">
          Get actionable suggestions to improve your CV with AI-powered analysis.
        </p>
      </div>

      {/* Tailor resume for job (when opened from Browse Jobs with ?jobId=) */}
      {jobIdFromUrl && jobForTailor && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <FileSearch className="w-5 h-5 text-primary" />
              Tailoring your resume for: {jobForTailor.title}
            </CardTitle>
            <CardDescription>
              We tailor your resume to the role while keeping every skill from your CV (job matches are highlighted).
              Each job keeps a short role description plus bullets so recruiters see what you did. PDF and HTML
              downloads use the same self-contained HTML the server turns into a PDF.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!tailoredCvText ? (
              <Button
                onClick={() => tailorMutation.mutate()}
                disabled={tailorMutation.isPending}
                className="gap-2"
              >
                {tailorMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating tailored resume…
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Generate tailored resume
                  </>
                )}
              </Button>
            ) : (
              <>
                {tailorKeyChanges.length > 0 && (
                  <div>
                    <p className="text-sm font-medium mb-1.5">What we changed</p>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      {tailorKeyChanges.map((c, i) => (
                        <li key={i} className="flex gap-2">
                          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                          {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div>
                  <p className="text-sm font-medium mb-1.5">
                    {structuredResume ? 'Formatted resume preview (template layout)' : 'Updated resume preview'}
                  </p>
                  <div className="rounded-lg border bg-white text-gray-900 shadow-sm p-4 max-h-[520px] overflow-y-auto print:shadow-none">
                    {structuredResume ? (
                      <div
                        className="resume-template-preview"
                        style={{ width: '100%', maxWidth: '100%', minWidth: 0 }}
                        dangerouslySetInnerHTML={{
                          __html: populateResumeTemplate(structuredResume, {
                            highlightTerms: [
                              ...(jobForTailor?.mustHaveSkills ?? []),
                              ...(jobForTailor?.niceToHaveSkills ?? []),
                            ],
                          }),
                        }}
                      />
                    ) : (
                      <pre className="whitespace-pre-wrap text-sm font-sans text-foreground/90">{tailoredCvText}</pre>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    {structuredResume
                      ? 'PDF: server renders this same HTML with Puppeteer. HTML: identical file for your own archive or print-to-PDF.'
                      : 'No structured data available; download uses server-generated PDF from your text.'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={async () => {
                      if (!tailoredCvText) return;
                      setPdfLoading(true);
                      try {
                        const blob = await exportTailoredResumePdf({
                          tailoredCvText,
                          structuredResume: structuredResume ?? undefined,
                          highlightTerms: [
                            ...(jobForTailor?.mustHaveSkills ?? []),
                            ...(jobForTailor?.niceToHaveSkills ?? []),
                          ],
                        });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `tailored-resume-${tailorJobTitle.replace(/\s+/g, '-')}.pdf`;
                        a.click();
                        URL.revokeObjectURL(url);
                        toast({ title: 'Download started', description: 'Your resume PDF is downloading.' });
                      } catch (err: any) {
                        toast({ title: 'Download failed', description: err?.message || 'Try again.', variant: 'destructive' });
                      } finally {
                        setPdfLoading(false);
                      }
                    }}
                    disabled={pdfLoading}
                    className="gap-2"
                  >
                    {pdfLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    Download PDF
                  </Button>
                  {structuredResume ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setHtmlLoading(true);
                        try {
                          const html = buildResumeHTMLTemplate(structuredResume, {
                            highlightTerms: [
                              ...(jobForTailor?.mustHaveSkills ?? []),
                              ...(jobForTailor?.niceToHaveSkills ?? []),
                            ],
                          });
                          const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `tailored-resume-${tailorJobTitle.replace(/\s+/g, '-')}.html`;
                          a.click();
                          URL.revokeObjectURL(url);
                          toast({
                            title: 'HTML downloaded',
                            description: 'Same document the server uses for PDF. Open in a browser or print to PDF.',
                          });
                        } catch (err: any) {
                          toast({
                            title: 'Download failed',
                            description: err?.message || 'Try again.',
                            variant: 'destructive',
                          });
                        } finally {
                          setHtmlLoading(false);
                        }
                      }}
                      disabled={htmlLoading}
                      className="gap-2"
                    >
                      {htmlLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileCode2 className="w-4 h-4" />}
                      Download HTML
                    </Button>
                  ) : null}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Matched Jobs Section */}
      {availableJobs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Briefcase className="w-5 h-5 text-primary" />
              Review for a Specific Job
            </CardTitle>
            <CardDescription>
              Select a matched job to get targeted CV feedback for that role. The AI will
              check if your CV highlights the right skills and experience.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Select
              value={selectedJobId}
              onValueChange={handleJobSelect}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a matched job…" />
              </SelectTrigger>
              <SelectContent>
                {availableJobs.map((j) => (
                  <SelectItem key={j.id} value={j.id}>
                    <span className="flex items-center gap-2">
                      {j.title}
                      {j.company && <span className="text-muted-foreground">— {j.company}</span>}
                      <span className="text-xs text-muted-foreground">({j.score}% match)</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Selected job details card */}
            {selectedJob && (
              <div className="flex items-center gap-4 p-3 rounded-lg bg-muted/50 border">
                <ScoreBadge score={selectedJob.score} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{selectedJob.title}</p>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {selectedJob.company && <span>{selectedJob.company}</span>}
                    {selectedJob.city && (
                      <span className="flex items-center gap-0.5">
                        <MapPin className="w-3 h-3" />
                        {selectedJob.city}, {getCountryFromCode(selectedJob.country)}
                      </span>
                    )}
                    {selectedJob.seniorityLevel && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 capitalize">
                        {selectedJob.seniorityLevel}
                      </Badge>
                    )}
                  </div>
                </div>
                <Link href={`/candidate/jobs/${selectedJob.id}`}>
                  <Button variant="outline" size="sm" className="text-xs">
                    View Job
                  </Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Trigger Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            Review My CV
          </CardTitle>
          <CardDescription>
            We'll analyze your latest uploaded CV for weak action verbs, missing achievements,
            formatting issues, and keyword gaps.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="text-sm font-medium mb-1 block">
                Target Role {selectedJobId ? '(from selected job)' : '(optional)'}
              </label>
              <Input
                placeholder="e.g. Senior Frontend Developer"
                value={targetRole}
                onChange={(e) => {
                  setTargetRole(e.target.value);
                  // Clear job selection if manually typing
                  if (selectedJobId) setSelectedJobId('');
                }}
              />
            </div>
            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="gap-2"
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Analyzing…
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Analyze CV
                </>
              )}
            </Button>
          </div>
          {mutation.isPending && (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              AI is reviewing your CV… This may take 20-30 seconds.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Results */}
      {result && (
        <>
          {/* Score Card */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-6">
                <div className="text-center">
                  <div className={`text-5xl font-bold ${scoreColor(result.score)}`}>
                    {result.score}
                  </div>
                  <div className={`text-sm font-medium ${scoreColor(result.score)}`}>
                    {scoreLabel(result.score)}
                  </div>
                </div>
                <div className="flex-1">
                  <Progress value={result.score} className="h-3" />
                  <p className="text-sm text-muted-foreground mt-2">{result.summary}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Sections */}
          <div className="grid gap-4 md:grid-cols-2">
            {result.sections.map((section, idx) => (
              <Card key={idx}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{section.section}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {section.issues.length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-red-600 flex items-center gap-1 mb-1">
                        <AlertTriangle className="w-3.5 h-3.5" /> Issues
                      </p>
                      <ul className="text-sm space-y-1">
                        {section.issues.map((issue, i) => (
                          <li key={i} className="text-muted-foreground flex items-start gap-1.5">
                            <span className="text-red-400 mt-1">•</span>
                            {issue}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {section.suggestions.length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-green-600 flex items-center gap-1 mb-1">
                        <Lightbulb className="w-3.5 h-3.5" /> Suggestions
                      </p>
                      <ul className="text-sm space-y-1">
                        {section.suggestions.map((sug, i) => (
                          <li key={i} className="text-muted-foreground flex items-start gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5 text-green-400 mt-0.5 flex-shrink-0" />
                            {sug}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Next Steps */}
          {availableJobs.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Next Steps</CardTitle>
                <CardDescription>
                  Based on your review, consider tailoring your CV for these jobs.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {availableJobs.slice(0, 5).map((j) => (
                    <div
                      key={j.id}
                      className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                    >
                      <ScoreBadge score={j.score} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{j.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {j.company} {j.city && `· ${j.city}`}
                        </p>
                      </div>
                      <div className="flex gap-1.5">
                        <Link href={`/candidate/jobs/${j.id}`}>
                          <Button variant="outline" size="sm" className="text-xs h-7">
                            View
                          </Button>
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Empty state — no matched jobs */}
      {!jobsLoading && availableJobs.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center">
            <Briefcase className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm font-medium">No Matched Jobs Yet</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
              Upload your CV from the Dashboard to get AI-matched jobs.
              You can then review your CV against specific job requirements.
            </p>
            <Link href="/candidate">
              <Button variant="outline" size="sm" className="mt-3">
                Go to Dashboard
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
