import { useLocation, Link } from 'wouter';
import { useAuthStore } from '@/store/auth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getUnreadNotificationCount, getUnreadMessageCount } from '@/api';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  SidebarFooter,
  useSidebar,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  LayoutDashboard,
  FileText,
  Upload,
  Briefcase,
  Settings,
  User,
  LogOut,
  Moon,
  Sun,
  Sparkles,
  RefreshCw,
  Building2,
  ClipboardList,
  Bell,
  Columns3,
  MessageSquare,
  Bookmark,
  BarChart3,
  Phone,
  Shield,
  Users,
  FileSearch,
  MessageCircleQuestion,
  Timer,
  DollarSign,
} from 'lucide-react';

interface AppLayoutProps {
  children: React.ReactNode;
}

const adminMenuItems = [
  { title: 'Dashboard', url: '/admin/dashboard', icon: LayoutDashboard },
  { title: 'Usage & Cost', url: '/admin/usage', icon: DollarSign },
  { title: 'Call Statistics', url: '/admin/call-statistics', icon: Phone },
  { title: 'CVs', url: '/admin/cvs', icon: FileText },
  { title: 'Upload CVs', url: '/admin/cvs/upload', icon: Upload },
  { title: 'Jobs', url: '/admin/jobs', icon: Briefcase },
  { title: 'Analytics', url: '/admin/analytics', icon: BarChart3 },
  { title: 'Messages', url: '/messages', icon: MessageSquare },
  { title: 'Bulk Operations', url: '/admin/bulk-operations', icon: RefreshCw },
  { title: 'Settings', url: '/admin/settings', icon: Settings },
];

const candidateMenuItems = [
  { title: 'Dashboard', url: '/candidate/dashboard', icon: LayoutDashboard },
  { title: 'Browse Jobs', url: '/candidate/jobs', icon: Briefcase },
  { title: 'My Applications', url: '/candidate/applications', icon: ClipboardList },
  { title: 'Interviews', url: '/candidate/interviews', icon: Timer },
  { title: 'Saved Jobs', url: '/candidate/saved-jobs', icon: Bookmark },
  { title: 'Messages', url: '/messages', icon: MessageSquare },
  { title: 'Notifications', url: '/notifications', icon: Bell },
  { title: 'AI CV Review', url: '/candidate/cv-review', icon: FileSearch },
  { title: 'My Profile', url: '/candidate/profile', icon: User },
  { title: 'Privacy', url: '/candidate/privacy', icon: Shield },
];

const companyMenuItems = [
  { title: 'Dashboard', url: '/company/dashboard', icon: LayoutDashboard },
  { title: 'Company Profile', url: '/company/profile', icon: Building2 },
  { title: 'Jobs', url: '/company/jobs', icon: Briefcase },
  { title: 'Candidates', url: '/company/candidates', icon: Users },
  { title: 'Interview Prep', url: '/company/interview-prep', icon: MessageCircleQuestion },
  { title: 'Analytics', url: '/company/analytics', icon: BarChart3 },
  { title: 'Messages', url: '/messages', icon: MessageSquare },
  { title: 'Notifications', url: '/notifications', icon: Bell },
  { title: 'Team & Settings', url: '/company/settings', icon: Settings },
];

type MenuItem = { title: string; url: string; icon: React.ComponentType<{ className?: string }> };

function SidebarNavMenu({
  menuItems,
  roleLabel,
  role,
  location: currentLocation,
}: {
  menuItems: MenuItem[];
  roleLabel: string;
  role: string;
  location: string;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-xs font-medium text-muted-foreground px-2">
        {roleLabel}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {menuItems.map((item) => {
            const isActive = currentLocation === item.url || currentLocation.startsWith(item.url + '/');
            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton asChild isActive={isActive} className="w-full">
                  <Link href={item.url} onClick={() => setOpenMobile(false)}>
                    <item.icon className="w-4 h-4" />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AppLayout({ children }: AppLayoutProps) {
  const [location, setLocation] = useLocation();
  const { user, logout, theme, toggleTheme, isAuthenticated } = useAuthStore();

  // Fetch unread notification count
  const { data: unreadData } = useQuery({
    queryKey: ['unread-count'],
    queryFn: getUnreadNotificationCount,
    enabled: isAuthenticated,
    refetchInterval: 30000, // Refresh every 30 seconds
  });
  const unreadCount = unreadData?.unreadCount || 0;

  // Fetch unread message count
  const { data: unreadMsgData } = useQuery({
    queryKey: ['unread-messages'],
    queryFn: getUnreadMessageCount,
    enabled: isAuthenticated,
    refetchInterval: 15000,
  });
  const unreadMsgCount = unreadMsgData?.unreadCount || 0;

  const role = user?.role || 'candidate';
  const menuItems =
    role === 'admin'
      ? adminMenuItems
      : role === 'company'
      ? companyMenuItems
      : candidateMenuItems;

  const dashboardUrl =
    role === 'admin'
      ? '/admin/dashboard'
      : role === 'company'
      ? '/company/dashboard'
      : '/candidate/dashboard';

  const roleLabelMap = {
    admin: 'Admin Panel',
    company: 'Company Portal',
    candidate: 'Candidate Portal',
  };

  // Determine avatar image
  const avatarUrl = user?.photoUrl || user?.logoUrl || user?.avatar || undefined;

  const sidebarStyle = {
    '--sidebar-width': '16rem',
    '--sidebar-width-icon': '3rem',
  } as React.CSSProperties;

  const isVoiceInterviewReport =
    location.startsWith('/candidate/voice-interviews/') && location.endsWith('/report');
  const isVoiceInterviewRoom =
    (location.startsWith('/candidate/voice-interviews') && !isVoiceInterviewReport) ||
    location === '/candidate/test-voice-interview';
  if (isVoiceInterviewRoom) {
    return <div className="h-screen w-full overflow-hidden">{children}</div>;
  }
  if (isVoiceInterviewReport) {
    return (
      <div className="h-screen w-full overflow-y-auto overflow-x-hidden">{children}</div>
    );
  }

  return (
    <SidebarProvider style={sidebarStyle}>
      <div className="flex h-screen w-full overflow-hidden">
        <Sidebar className="border-r border-sidebar-border">
          <SidebarHeader className="p-4 border-b border-sidebar-border">
            <Link href={dashboardUrl}>
              <div className="flex items-center gap-3 cursor-pointer">
                <div className="flex items-center justify-center w-9 h-9 rounded-md bg-primary text-primary-foreground">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div className="flex flex-col">
                  <span className="font-semibold text-sm text-sidebar-foreground">CV Matcher</span>
                  <span className="text-xs text-sidebar-foreground/80">Powered by AI</span>
                </div>
              </div>
            </Link>
          </SidebarHeader>

          <SidebarContent className="p-2">
            <SidebarNavMenu
              menuItems={menuItems}
              roleLabel={roleLabelMap[role]}
              role={role}
              location={location}
            />
          </SidebarContent>

          <SidebarFooter className="p-3 border-t border-sidebar-border">
            <div className="flex items-center gap-3 p-2 rounded-md bg-sidebar-accent/50">
              <Avatar className="w-8 h-8">
                {avatarUrl && <AvatarImage src={avatarUrl} />}
                <AvatarFallback className="bg-primary/10 text-primary text-xs flex items-center justify-center">
                  {(() => {
                    const initials = user?.name?.trim() && user.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
                    return initials || <User className="w-4 h-4" />;
                  })()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {role === 'company' ? (user?.companyName || user?.name) : user?.name}
                </p>
                <p className="text-xs text-sidebar-foreground/80 capitalize">{user?.role}</p>
              </div>
            </div>
          </SidebarFooter>
        </Sidebar>

        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center justify-between h-14 px-4 border-b border-sidebar-border bg-header text-header-foreground shadow-header [&_button]:text-header-foreground [&_button:hover]:bg-white/10 [&_button:hover]:text-header-foreground">
            <div className="flex items-center gap-4">
              <SidebarTrigger data-testid="button-sidebar-toggle" />
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="relative"
                onClick={() => setLocation('/messages')}
                data-testid="button-messages"
              >
                <MessageSquare className="w-4 h-4" />
                {unreadMsgCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center w-4 h-4 text-[10px] font-bold text-white bg-blue-500 rounded-full">
                    {unreadMsgCount > 9 ? '9+' : unreadMsgCount}
                  </span>
                )}
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className="relative"
                onClick={() => setLocation('/notifications')}
                data-testid="button-notifications"
              >
                <Bell className="w-4 h-4" />
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center w-4 h-4 text-[10px] font-bold text-white bg-red-500 rounded-full">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </Button>

              <Button
                variant="ghost"
                size="icon"
                onClick={toggleTheme}
                data-testid="button-toggle-theme"
              >
                {theme === 'light' ? (
                  <Moon className="w-4 h-4" />
                ) : (
                  <Sun className="w-4 h-4" />
                )}
              </Button>

              <Button
                variant="ghost"
                size="icon"
                onClick={logout}
                data-testid="button-logout"
              >
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
          </header>

          <main className="flex-1 overflow-auto p-3 sm:p-4 md:p-6 custom-scrollbar">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
