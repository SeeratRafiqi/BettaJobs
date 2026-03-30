import { useQuery } from '@tanstack/react-query';
import { Link, useRoute } from 'wouter';
import { getVoiceInterviewReport } from '@/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, FileText } from 'lucide-react';
import { formatDateTime } from '@/utils/helpers';

export default function VoiceInterviewReport() {
  const [, params] = useRoute('/candidate/voice-interviews/:id/report');
  const sessionId = params?.id || '';

  const { data, isLoading } = useQuery({
    queryKey: ['voice-interview-report', sessionId],
    queryFn: () => getVoiceInterviewReport(sessionId),
    enabled: !!sessionId,
  });

  const report = data?.report;

  if (isLoading || !sessionId) {
    return (
      <div className="container max-w-3xl py-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!report) {
    return (
      <div className="container max-w-3xl py-6">
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">Report not found.</p>
            <Link href="/candidate/interviews">
              <Button variant="ghost" className="mt-2">Back to Interviews</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="container max-w-3xl py-6 space-y-6 pb-12">
          <div className="flex items-center gap-3">
            <Link href="/candidate/interviews">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-xl font-semibold flex items-center gap-2">
                <FileText className="w-5 h-5" />
                Voice Interview Report
              </h1>
              <p className="text-sm text-muted-foreground">{report.jobTitle}</p>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
              <CardDescription>
                {report.completedAt
                  ? `Completed ${formatDateTime(report.completedAt)}`
                  : 'Interview session'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {report.outcome ? (
                <div
                  className="rounded-lg border bg-muted/30 p-4 text-sm whitespace-pre-wrap max-h-[420px] overflow-y-auto"
                  role="region"
                  aria-label="Interview summary"
                >
                  {report.outcome}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-2">
                  No summary available yet. Your answers are listed below. The summary may appear after the interview is processed.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Questions &amp; Answers</CardTitle>
              <CardDescription>Your responses from the voice interview</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6 max-h-[600px] overflow-y-auto">
              {report.qa.length === 0 ? (
                <p className="text-sm text-muted-foreground">No questions and answers recorded.</p>
              ) : (
                report.qa.map((item, idx) => (
                  <div key={idx} className="space-y-2">
                    <p className="font-medium text-sm text-muted-foreground">Question {idx + 1}</p>
                    <p className="text-sm">{item.question}</p>
                    <p className="pl-3 border-l-2 border-primary/50 text-sm">{item.answer || '(No answer)'}</p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Link href="/candidate/interviews">
            <Button variant="outline" className="gap-2">
              <ArrowLeft className="w-4 h-4" />
              Back to Interviews
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
