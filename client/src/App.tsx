import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuthStore } from "@/store/auth";
import { AppLayout } from "@/components/layout/AppLayout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useEffect } from "react";

// Auth pages
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import NotFound from "@/pages/not-found";

// Admin pages
import AdminDashboard from "@/pages/admin/Dashboard";
import CvList from "@/pages/admin/CvList";
import CvUpload from "@/pages/admin/CvUpload";
import CvDetail from "@/pages/admin/CvDetail";
import JobList from "@/pages/admin/JobList";
import JobNew from "@/pages/admin/JobNew";
import JobNewFromUrl from "@/pages/admin/JobNewFromUrl";
import JobDetail from "@/pages/admin/JobDetail";
import Settings from "@/pages/admin/Settings";
import BulkOperations from "@/pages/admin/BulkOperations";

// Candidate pages
import CandidateDashboard from "@/pages/candidate/Dashboard";
import CandidateProfile from "@/pages/candidate/Profile";
import CandidateJobList from "@/pages/candidate/JobList";
import CandidateJobDetail from "@/pages/candidate/JobDetail";

// Company pages
import CompanyDashboard from "@/pages/company/Dashboard";
import CompanyProfile from "@/pages/company/Profile";
import CompanyJobs from "@/pages/company/Jobs";
import CompanyJobDetail from "@/pages/company/JobDetail";
import PostJob from "@/pages/company/PostJob";
import CompanyPipeline from "@/pages/company/Pipeline";
import CompanySettings from "@/pages/company/Settings";

// Candidate applications
import CandidateApplications from "@/pages/candidate/Applications";
import CandidateInterviews from "@/pages/candidate/Interviews";
import CandidateInterviewAssessment from "@/pages/candidate/InterviewAssessment";
import VoiceInterviewRoom from "@/pages/candidate/VoiceInterviewRoom";
import VoiceInterviewReport from "@/pages/candidate/VoiceInterviewReport";
import TestVoiceInterview from "@/pages/candidate/TestVoiceInterview";

// Candidate pages (Phase 4 & 5)
import CandidateSavedJobs from "@/pages/candidate/SavedJobs";
import CandidatePrivacySettings from "@/pages/candidate/PrivacySettings";

// Candidate pages (Phase 6 — AI)
import CvReview from "@/pages/candidate/CvReview";

// Company pages (Phase 4)
import CompanyAnalytics from "@/pages/company/Analytics";
import CompanyCandidates from "@/pages/company/Candidates";
import CompanyCandidateProfile from "@/pages/company/CandidateProfile";
import CompanyPostJobFromUrl from "@/pages/company/PostJobFromUrl";

// Company pages (Phase 6 — AI)
import InterviewPrep from "@/pages/company/InterviewPrep";

// Admin pages (Phase 4)
import AdminAnalytics from "@/pages/admin/Analytics";
import UsageCost from "@/pages/admin/UsageCost";
import CallStatistics from "@/pages/admin/CallStatistics";

// Shared pages
import NotificationsPage from "@/pages/Notifications";
import MessagesPage from "@/pages/Messages";

// AI Chat Widget (Phase 6)
import { AiChatWidget } from "@/components/AiChatWidget";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isAuthenticated) {
      setLocation("/login");
    }
  }, [isAuthenticated, setLocation]);

  if (!isAuthenticated) {
    return null;
  }

  return <AppLayout>{children}</AppLayout>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user?.role !== "admin") {
      if (user?.role === "company") setLocation("/company/dashboard");
      else setLocation("/candidate/dashboard");
    }
  }, [user?.role, setLocation]);

  if (user?.role !== "admin") {
    return null;
  }

  return <>{children}</>;
}

function CandidateRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user?.role !== "candidate") {
      if (user?.role === "admin") setLocation("/admin/dashboard");
      else setLocation("/company/dashboard");
    }
  }, [user?.role, setLocation]);

  if (user?.role !== "candidate") {
    return null;
  }

  return <>{children}</>;
}

function CompanyRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user?.role !== "company") {
      if (user?.role === "admin") setLocation("/admin/dashboard");
      else setLocation("/candidate/dashboard");
    }
  }, [user?.role, setLocation]);

  if (user?.role !== "company") {
    return null;
  }

  return <>{children}</>;
}

function HomeRedirect() {
  const { isAuthenticated, user } = useAuthStore();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isAuthenticated) {
      setLocation("/login");
    } else if (user?.role === "admin") {
      setLocation("/admin/dashboard");
    } else if (user?.role === "company") {
      setLocation("/company/dashboard");
    } else {
      setLocation("/candidate/dashboard");
    }
  }, [isAuthenticated, user?.role, setLocation]);

  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeRedirect} />
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />

      {/* Admin Routes */}
      <Route path="/admin/dashboard">
        <ProtectedRoute>
          <AdminRoute>
            <AdminDashboard />
          </AdminRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/admin/cvs">
        <ProtectedRoute>
          <AdminRoute>
            <CvList />
          </AdminRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/admin/cvs/upload">
        <ProtectedRoute>
          <AdminRoute>
            <CvUpload />
          </AdminRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/admin/cvs/:id">
        <ProtectedRoute>
          <AdminRoute>
            <CvDetail />
          </AdminRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/admin/jobs">
        <ProtectedRoute>
          <AdminRoute>
            <JobList />
          </AdminRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/admin/jobs/new">
        <ProtectedRoute>
          <AdminRoute>
            <JobNew />
          </AdminRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/admin/jobs/new-from-url">
        <ProtectedRoute>
          <AdminRoute>
            <JobNewFromUrl />
          </AdminRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/admin/jobs/:id">
        <ProtectedRoute>
          <AdminRoute>
            <JobDetail />
          </AdminRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/admin/bulk-operations">
        <ProtectedRoute>
          <AdminRoute>
            <BulkOperations />
          </AdminRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/admin/analytics">
        <ProtectedRoute>
          <AdminRoute>
            <AdminAnalytics />
          </AdminRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/admin/usage">
        <ProtectedRoute>
          <AdminRoute>
            <UsageCost />
          </AdminRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/admin/call-statistics">
        <ProtectedRoute>
          <AdminRoute>
            <CallStatistics />
          </AdminRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/admin/settings">
        <ProtectedRoute>
          <AdminRoute>
            <Settings />
          </AdminRoute>
        </ProtectedRoute>
      </Route>

      {/* Candidate Routes */}
      <Route path="/candidate/dashboard">
        <ProtectedRoute>
          <CandidateRoute>
            <CandidateDashboard />
          </CandidateRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/candidate/profile">
        <ProtectedRoute>
          <CandidateRoute>
            <CandidateProfile />
          </CandidateRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/candidate/jobs">
        <ProtectedRoute>
          <CandidateRoute>
            <CandidateJobList />
          </CandidateRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/candidate/jobs/:id">
        <ProtectedRoute>
          <CandidateRoute>
            <CandidateJobDetail />
          </CandidateRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/candidate/applications">
        <ProtectedRoute>
          <CandidateRoute>
            <CandidateApplications />
          </CandidateRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/candidate/interviews">
        <ProtectedRoute>
          <CandidateRoute>
            <CandidateInterviews />
          </CandidateRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/candidate/interviews/:id">
        <ProtectedRoute>
          <CandidateRoute>
            <CandidateInterviewAssessment />
          </CandidateRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/candidate/test-voice-interview">
        <ProtectedRoute>
          <CandidateRoute>
            <TestVoiceInterview />
          </CandidateRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/candidate/voice-interviews/:id/report">
        <ProtectedRoute>
          <CandidateRoute>
            <VoiceInterviewReport />
          </CandidateRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/candidate/voice-interviews/:id">
        <ProtectedRoute>
          <CandidateRoute>
            <VoiceInterviewRoom />
          </CandidateRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/candidate/saved-jobs">
        <ProtectedRoute>
          <CandidateRoute>
            <CandidateSavedJobs />
          </CandidateRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/candidate/privacy">
        <ProtectedRoute>
          <CandidateRoute>
            <CandidatePrivacySettings />
          </CandidateRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/candidate/cv-review">
        <ProtectedRoute>
          <CandidateRoute>
            <CvReview />
          </CandidateRoute>
        </ProtectedRoute>
      </Route>

      {/* Company Routes */}
      <Route path="/company/dashboard">
        <ProtectedRoute>
          <CompanyRoute>
            <CompanyDashboard />
          </CompanyRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/company/profile">
        <ProtectedRoute>
          <CompanyRoute>
            <CompanyProfile />
          </CompanyRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/company/jobs">
        <ProtectedRoute>
          <CompanyRoute>
            <CompanyJobs />
          </CompanyRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/company/jobs/new">
        <ProtectedRoute>
          <CompanyRoute>
            <PostJob />
          </CompanyRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/company/jobs/from-url">
        <ProtectedRoute>
          <CompanyRoute>
            <CompanyPostJobFromUrl />
          </CompanyRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/company/jobs/:id/pipeline">
        <ProtectedRoute>
          <CompanyRoute>
            <CompanyPipeline />
          </CompanyRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/company/jobs/:id">
        <ProtectedRoute>
          <CompanyRoute>
            <CompanyJobDetail />
          </CompanyRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/company/candidates/:id">
        <ProtectedRoute>
          <CompanyRoute>
            <CompanyCandidateProfile />
          </CompanyRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/company/candidates">
        <ProtectedRoute>
          <CompanyRoute>
            <CompanyCandidates />
          </CompanyRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/company/analytics">
        <ProtectedRoute>
          <CompanyRoute>
            <CompanyAnalytics />
          </CompanyRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/company/settings">
        <ProtectedRoute>
          <CompanyRoute>
            <CompanySettings />
          </CompanyRoute>
        </ProtectedRoute>
      </Route>
      <Route path="/company/interview-prep">
        <ProtectedRoute>
          <CompanyRoute>
            <InterviewPrep />
          </CompanyRoute>
        </ProtectedRoute>
      </Route>
      {/* Notifications (all roles) */}
      <Route path="/notifications">
        <ProtectedRoute>
          <NotificationsPage />
        </ProtectedRoute>
      </Route>

      {/* Messages (all roles) */}
      <Route path="/messages">
        <ProtectedRoute>
          <MessagesPage />
        </ProtectedRoute>
      </Route>

      {/* Fallback */}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const { theme } = useAuthStore();

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <Router />
          <AiChatWidget />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
