import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/store/auth';
import {
  getFaqAnswerForRole,
  getFaqSuggestionsForRole,
  resolveHelpPersonaRole,
  findFaqEntryByExactQuestion,
} from '@/data/faq';
import { aiChat } from '@/api';
import { useToast } from '@/hooks/use-toast';
import {
  MessageCircle,
  X,
  Send,
  Minimize2,
  HelpCircle,
  Loader2,
} from 'lucide-react';

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
}

export function AiChatWidget() {
  const { isAuthenticated, user } = useAuthStore();
  const [location] = useLocation();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<ChatEntry[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const helpPersona = useMemo(
    () =>
      resolveHelpPersonaRole({
        userRole: user?.role,
        pathname: location,
        companyId: user?.companyId,
        candidateId: user?.candidateId,
      }),
    [user?.role, user?.companyId, user?.candidateId, location]
  );

  useEffect(() => {
    if (!open) return;
    setSuggestions(getFaqSuggestionsForRole(helpPersona, 6, { seed: Date.now() }));
  }, [open, helpPersona]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [history, sending]);

  const replyWithAi = useCallback(
    async (msg: string, prior: ChatEntry[]) => {
      setSending(true);
      try {
        const { response } = await aiChat(msg, prior);
        const text = response?.trim() || 'Sorry, I had no response. Please try again.';
        setHistory((h) => [...h, { role: 'assistant', content: text }]);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Chat request failed';
        toast({
          title: 'Assistant unavailable',
          description: message,
          variant: 'destructive',
        });
        setHistory((h) => [
          ...h,
          {
            role: 'assistant',
            content:
              'I could not reach the AI assistant. Check your connection and API configuration, or try again in a moment.',
          },
        ]);
      } finally {
        setSending(false);
      }
    },
    [toast]
  );

  const submitMessage = useCallback(
    async (msg: string) => {
      const trimmed = msg.trim();
      if (!trimmed || sending) return;

      const prior = historyRef.current;
      const faq = getFaqAnswerForRole(trimmed, helpPersona);

      if (faq) {
        setHistory((h) => [
          ...h,
          { role: 'user', content: trimmed },
          { role: 'assistant', content: faq.answer },
        ]);
        return;
      }

      setHistory((h) => [...h, { role: 'user', content: trimmed }]);
      await replyWithAi(trimmed, prior);
    },
    [replyWithAi, sending, helpPersona]
  );

  const handleSend = () => {
    if (!input.trim() || sending) return;
    const msg = input.trim();
    setInput('');
    void submitMessage(msg);
  };

  const handleSuggestion = (question: string) => {
    setInput('');
    const entry = findFaqEntryByExactQuestion(question, helpPersona);
    if (entry) {
      setHistory((h) => [
        ...h,
        { role: 'user', content: question },
        { role: 'assistant', content: entry.answer },
      ]);
      return;
    }
    const faq = getFaqAnswerForRole(question, helpPersona);
    if (faq) {
      setHistory((h) => [
        ...h,
        { role: 'user', content: question },
        { role: 'assistant', content: faq.answer },
      ]);
      return;
    }
    void submitMessage(question);
  };

  if (!isAuthenticated) return null;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:scale-110 transition-transform"
        aria-label="Open help"
      >
        <MessageCircle className="w-6 h-6" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 w-[360px] h-[500px] bg-background border rounded-xl shadow-2xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b bg-primary text-primary-foreground rounded-t-xl">
        <div className="flex items-center gap-2">
          <HelpCircle className="w-4 h-4" />
          <span className="font-semibold text-sm">Help</span>
        </div>
        <div className="flex gap-1">
          <button onClick={() => setOpen(false)} className="p-1 hover:bg-white/20 rounded">
            <Minimize2 className="w-4 h-4" />
          </button>
          <button onClick={() => { setOpen(false); setHistory([]); }} className="p-1 hover:bg-white/20 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {history.length === 0 && (
          <div className="text-center py-6 space-y-3">
            <HelpCircle className="w-8 h-8 text-primary mx-auto" />
            <p className="text-sm text-muted-foreground">
              Hi {user?.name?.split(' ')[0] || 'there'}! Ask a question or pick one below.
            </p>
            <div className="flex flex-col gap-1.5">
              {suggestions.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={sending}
                  className="text-left text-xs px-3 py-2 rounded-lg border bg-muted/50 hover:bg-muted transition-colors disabled:opacity-50"
                  onClick={() => handleSuggestion(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {history.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="max-w-[85%] px-3 py-2 rounded-lg text-sm bg-muted flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              Thinking…
            </div>
          </div>
        )}
      </div>

      <div className="p-3 border-t">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question…"
            className="text-sm"
            autoFocus
          />
          <Button type="submit" size="icon" disabled={!input.trim() || sending}>
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </form>
      </div>
    </div>
  );
}
