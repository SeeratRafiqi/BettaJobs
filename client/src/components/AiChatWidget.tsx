import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/store/auth';
import { getFaqAnswer, getFaqSuggestions, FAQ_LIST } from '@/data/faq';
import {
  MessageCircle,
  X,
  Send,
  Minimize2,
  HelpCircle,
} from 'lucide-react';

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
}

export function AiChatWidget() {
  const { isAuthenticated, user } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<ChatEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const suggestions = getFaqSuggestions(6);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [history]);

  const handleSend = () => {
    if (!input.trim()) return;
    const msg = input.trim();
    setInput('');

    const faq = getFaqAnswer(msg);
    const response = faq
      ? faq.answer
      : `I'm the CV Matcher FAQ assistant. I can answer questions about uploading your CV, job matching, applying, tailoring your resume, cover letters, and more. Try one of the suggested questions below, or ask something like "How do I upload my CV?" or "How does job matching work?"`;

    setHistory((h) => [
      ...h,
      { role: 'user', content: msg },
      { role: 'assistant', content: response },
    ]);
  };

  const handleSuggestion = (question: string) => {
    setInput('');
    const entry = FAQ_LIST.find((e) => e.question === question);
    const answer = entry ? entry.answer : (getFaqAnswer(question)?.answer ?? 'No answer found.');
    setHistory((h) => [
      ...h,
      { role: 'user', content: question },
      { role: 'assistant', content: answer },
    ]);
  };

  if (!isAuthenticated) return null;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:scale-110 transition-transform"
        aria-label="Open FAQ"
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
          <span className="font-semibold text-sm">FAQ</span>
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
                  className="text-left text-xs px-3 py-2 rounded-lg border bg-muted/50 hover:bg-muted transition-colors"
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
          <Button type="submit" size="icon" disabled={!input.trim()}>
            <Send className="w-4 h-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
