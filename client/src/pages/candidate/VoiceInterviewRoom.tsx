import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useRoute } from 'wouter';
import {
  getVoiceInterviewSession,
  startVoiceInterview,
  submitVoiceInterviewAnswer,
  synthesizeVoiceInterviewTTS,
} from '@/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  Video,
  VideoOff,
  Volume2,
} from 'lucide-react';
import {
  initExpressionDetection,
  detectExpressionFromVideo,
  formatExpressionSummaryForOutcome,
  type ExpressionSummary,
} from '@/lib/expressionDetection';

const LANG_BCP47: Record<string, string> = {
  en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', hi: 'hi-IN',
  pt: 'pt-BR', ar: 'ar-SA', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR',
};

/** Pause after last speech before auto-submit (answer complete). Allows natural thinking pauses below this. */
const ANSWER_COMPLETE_PAUSE_MS = 2500;
/** Silence: no speech at all for this long → "Just checking — can you hear me?" */
const SILENCE_CHECK_FIRST_MS = 8000;
/** After first silence check, wait this long → "Are you still there?" */
const SILENCE_CHECK_SECOND_MS = 7000; // 8s + 7s = 15s total
/** Min/max delay before AI speaks (simulate thinking). */
const AI_THINKING_DELAY_MIN_MS = 600;
const AI_THINKING_DELAY_MAX_MS = 900;
/** After TTS ends, ignore speech results briefly to avoid speaker echo (use headphones if echo persists). */
const IGNORE_AFTER_TTS_MS = 1200;

/** Single mic capture for STT — echo cancellation helps when AI plays through speakers. */
const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

/** Returns true if transcript looks like the AI's last question (echo) so we don't submit it as the user's answer. */
function looksLikeAIEcho(transcript: string, lastSpokenQuestion: string | null): boolean {
  if (!lastSpokenQuestion || !transcript) return false;
  const t = transcript.trim().toLowerCase().replace(/\s+/g, ' ');
  const q = lastSpokenQuestion.trim().toLowerCase().replace(/\s+/g, ' ');
  if (t.length < 15 || q.length < 15) return false;
  return q.includes(t) || t.includes(q.slice(0, 30));
}

let activeTTSAudio: HTMLAudioElement | null = null;
let activeTTSObjectUrl: string | null = null;

function stopVoiceInterviewTTSPlayback() {
  if (activeTTSAudio) {
    try {
      activeTTSAudio.pause();
    } catch {
      /* ignore */
    }
    activeTTSAudio.src = '';
    activeTTSAudio = null;
  }
  if (activeTTSObjectUrl) {
    URL.revokeObjectURL(activeTTSObjectUrl);
    activeTTSObjectUrl = null;
  }
}

/** Qwen TTS via POST /api/voice-interviews/tts (auth Bearer token via api client). */
async function speakQuestion(
  text: string,
  onEnd?: () => void,
  languageCode?: string,
  onError?: (message: string) => void,
) {
  const finish = () => {
    onEnd?.();
  };
  if (!text || typeof window === 'undefined') {
    finish();
    return;
  }
  stopVoiceInterviewTTSPlayback();
  const lang = (languageCode || 'en').split('-')[0] || 'en';
  let blob: Blob;
  try {
    blob = await synthesizeVoiceInterviewTTS(text, lang);
  } catch (err) {
    onError?.(err instanceof Error ? err.message : 'Could not load AI voice audio');
    finish();
    return;
  }
  const url = URL.createObjectURL(blob);
  activeTTSObjectUrl = url;
  const audio = new Audio(url);
  activeTTSAudio = audio;
  audio.onended = () => {
    stopVoiceInterviewTTSPlayback();
    finish();
  };
  audio.onerror = () => {
    onError?.('AI voice playback failed');
    stopVoiceInterviewTTSPlayback();
    finish();
  };
  try {
    await audio.play();
  } catch (err) {
    onError?.(err instanceof Error ? err.message : 'Could not play AI voice — check browser audio');
    stopVoiceInterviewTTSPlayback();
    finish();
  }
}

const INTERVIEW_LANGUAGES: { value: string; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'hi', label: 'Hindi' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ar', label: 'Arabic' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
];

function VoiceInterviewRoom() {
  const [, params] = useRoute('/candidate/voice-interviews/:id');
  const [, setLocation] = useLocation();
  const sessionId = params?.id || '';
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [response, setResponse] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [cameraOn, setCameraOn] = useState(false);
  const [expressionSamples, setExpressionSamples] = useState<ExpressionSummary[]>([]);
  const [preferredLanguage, setPreferredLanguage] = useState('en');
  const [isAIThinking, setIsAIThinking] = useState(false);
  /** Browser support: voice = SpeechRecognition + getUserMedia; media = getUserMedia (camera/mic). */
  const [browserSupport, setBrowserSupport] = useState<{ voice: boolean; media: boolean } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null);
  const lastSpokenQuestionRef = useRef<string | null>(null);
  const isListeningRef = useRef(false);
  const vadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestResponseRef = useRef('');
  const latestInterimRef = useRef('');
  const submittingRef = useRef(false);
  const lastSpeechActivityAtRef = useRef(Date.now());
  /** When true, ignore speech results (AI is speaking). Keeps mic running so no restart needed. */
  const isAISpeakingRef = useRef(false);
  /** Ignore results until this timestamp (ms) to avoid capturing tail of TTS. */
  const ignoreResultsUntilRef = useRef(0);
  /** True while we're doing the intentional stop+start after TTS (so rec.onend doesn't also start). */
  const restartingAfterTTSRef = useRef(false);
  /** 0 = before 8s silence, 1 = between 8s and 15s (after first check). */
  const silenceCheckPhaseRef = useRef(0);
  /** True when last submit was a silence check (so onSuccess should not clear idle timer). */
  const submittedSilenceCheckRef = useRef(false);
  /** Session status from previous render, for refetchInterval (session is defined after useQuery). */
  const sessionStatusRef = useRef<string | undefined>(undefined);
  /** Last time STT produced a result — used to detect dead recognition while mic UI is on. */
  const lastRecognitionResultAtRef = useRef(0);
  /** Stable interview language for effects that must not re-run on session object refetch. */
  const interviewLangRef = useRef('en');
  /** Called after TTS ends to start a fresh recognition so the next turn captures voice reliably. */
  const restartRecognitionAfterTTSRef = useRef<(langCode: string) => void>(() => {});
  /** Ensures SpeechRecognition is running when mic is on (called by health watchdog). */
  const ensureRecognitionActiveRef = useRef<() => void>(() => {});
  /** Reattach the real onresult/onend/onerror to the current rec. Set in startListening; called every time TTS ends so turn 2+ still capture voice. */
  const reattachHandlersRef = useRef<(rec: any, langCode: string) => void>(() => {});
  isListeningRef.current = isListening;
  isAISpeakingRef.current = isAISpeaking;
  latestResponseRef.current = response;
  latestInterimRef.current = interimTranscript;

  const sessionQuery = useQuery({
    queryKey: ['voice-interview-session', sessionId],
    queryFn: () => getVoiceInterviewSession(sessionId),
    enabled: !!sessionId,
    refetchInterval: sessionStatusRef.current === 'in_progress' && !isAIThinking ? 5000 : false,
  });

  const session = sessionQuery.data?.session;
  sessionStatusRef.current = session?.status;

  // One-time browser support check (for start screen message)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const voice =
      !!(window as any).SpeechRecognition || !!(window as any).webkitSpeechRecognition;
    const media = typeof navigator?.mediaDevices?.getUserMedia === 'function';
    setBrowserSupport({ voice, media });
  }, []);
  const [timeExpired, setTimeExpired] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  // 10-minute countdown: when in_progress and endsAt is set, tick every second
  useEffect(() => {
    if (session?.status !== 'in_progress' || !session?.endsAt) {
      setRemainingSeconds(null);
      return;
    }
    const endsAt = new Date(session.endsAt).getTime();
    const tick = () => {
      const now = Date.now();
      const rem = Math.max(0, Math.floor((endsAt - now) / 1000));
      setRemainingSeconds(rem);
      if (rem <= 0) {
        setTimeExpired(true);
        queryClient.invalidateQueries({ queryKey: ['voice-interview-session', sessionId] });
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [session?.status, session?.endsAt, sessionId, queryClient]);

  const interviewLang = (session as any)?.preferredLanguage ?? preferredLanguage;
  interviewLangRef.current = interviewLang || 'en';

  const reportTtsError = useCallback(
    (message: string) => {
      toast({
        title: 'AI voice unavailable',
        description: message || 'You can still read the question on screen and answer by speaking.',
        variant: 'destructive',
      });
    },
    [toast],
  );

  // Auto-speak when we have a new current question. After AI speaks, restart recognition so next turn captures voice (continuous call).
  useEffect(() => {
    const q = session?.status === 'in_progress' ? session?.currentQuestion : null;
    if (!q || q === lastSpokenQuestionRef.current) return;
    lastSpokenQuestionRef.current = q;
    setIsAISpeaking(true);
    const lang = interviewLang;
    const onEnd = () => {
      setIsAISpeaking(false);
      ignoreResultsUntilRef.current = Date.now() + IGNORE_AFTER_TTS_MS;
      latestResponseRef.current = '';
      latestInterimRef.current = '';
      silenceCheckPhaseRef.current = 0;
      lastSpeechActivityAtRef.current = Date.now();
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (isListeningRef.current) {
        idleTimerRef.current = setTimeout(() => silenceCheckRef.current(), SILENCE_CHECK_FIRST_MS);
      }
      // Reattach the real onresult handler every time TTS ends so turn 2+ still capture voice (fixes pre-warm no-op or lost handler).
      const rec = recognitionRef.current;
      if (rec && isListeningRef.current) {
        reattachHandlersRef.current(rec, lang || 'en');
      }
      // Restart recognition (stop + delayed start) so the mic keeps working like a real call.
      restartingAfterTTSRef.current = true;
      setTimeout(() => {
        if (!isListeningRef.current) {
          restartingAfterTTSRef.current = false;
          return;
        }
        restartRecognitionAfterTTSRef.current(lang || 'en');
        restartingAfterTTSRef.current = false;
      }, 300);
    };
    void speakQuestion(q, onEnd, lang || 'en', reportTtsError);
  }, [session?.currentQuestion, session?.status, interviewLang, reportTtsError]);

  // Camera only — mic is owned by audioStreamRef so STT and UI stay in sync (no dual mic capture).
  useEffect(() => {
    if (!cameraOn) return;
    let s: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: false })
      .then((stream) => {
        s = stream;
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.play().catch(() => {});
        } else {
          setTimeout(() => {
            const v = videoRef.current;
            if (v && streamRef.current) {
              v.srcObject = streamRef.current;
              v.play().catch(() => {});
            }
          }, 100);
        }
      })
      .catch((err: any) => {
        const msg = err?.message ?? '';
        if (msg.includes('Permission') || err?.name === 'NotAllowedError') {
          toast({ title: 'Camera & microphone denied', description: 'Allow access in your browser (address bar or site settings) and refresh.', variant: 'destructive' });
        } else {
          toast({ title: 'Camera unavailable', description: msg || 'Check that no other app is using your camera.', variant: 'destructive' });
        }
      });
    return () => {
      s?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [cameraOn, toast]);

  // Expression detection when camera is on (optional; requires models in /public/models)
  useEffect(() => {
    if (!cameraOn || !videoRef.current || session?.status !== 'in_progress') return;
    let mounted = true;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    initExpressionDetection().then((ready) => {
      if (!mounted || !ready) return;
      intervalId = setInterval(async () => {
        const video = videoRef.current;
        if (!video || video.readyState < 2) return;
        const result = await detectExpressionFromVideo(video);
        if (mounted && result) {
          setExpressionSamples((prev) => {
            const next = [...prev, result].slice(-20);
            return next;
          });
        }
      }, 2500);
    });
    return () => {
      mounted = false;
      if (intervalId) clearInterval(intervalId);
    };
  }, [cameraOn, session?.status]);

  // Pre-acquire microphone when interview is in progress (stable deps — do not tear down on session refetch).
  const sessionInProgress = session?.status === 'in_progress';
  useEffect(() => {
    if (!sessionInProgress || typeof navigator?.mediaDevices?.getUserMedia !== 'function') return;
    if (audioStreamRef.current?.active) return;

    let cancelled = false;
    navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS).then((stream) => {
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      audioStreamRef.current = stream;
    }).catch(() => {
      /* Mic permission may be granted later via the Mic button */
    });

    return () => {
      cancelled = true;
      // Only release mic when leaving in-progress (not when React Query refetches session).
      if (sessionStatusRef.current !== 'in_progress' && audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach((t) => t.stop());
        audioStreamRef.current = null;
      }
    };
  }, [sessionInProgress, interviewLang]);

  const startMutation = useMutation({
    mutationFn: (lang?: string) => startVoiceInterview(sessionId, { preferredLanguage: lang || preferredLanguage }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['voice-interview-session', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['candidate-voice-interviews'] });
      lastSpokenQuestionRef.current = null;
    },
    onError: (e: any) => {
      toast({
        title: 'Could not start interview',
        description: e?.message ?? 'Please try again.',
        variant: 'destructive',
      });
    },
  });

  const submitMutation = useMutation({
    mutationFn: (payload: { text: string; expressionSummary?: string | null }) =>
      submitVoiceInterviewAnswer(sessionId, payload.text, { expressionSummary: payload.expressionSummary }),
    onSuccess: (data) => {
      const wasSilenceCheck = submittedSilenceCheckRef.current;
      submittedSilenceCheckRef.current = false;
      submittingRef.current = false;
      if (vadTimerRef.current) {
        clearTimeout(vadTimerRef.current);
        vadTimerRef.current = null;
      }
      if (!wasSilenceCheck && idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      setResponse('');
      setInterimTranscript('');
      setExpressionSamples([]);
      if (data.done) {
        stopListening();
        setIsAIThinking(false);
        toast({ title: 'Interview completed', description: data.message });
        setLocation(`/candidate/voice-interviews/${sessionId}/report`);
      } else {
        const nextSession = (data as { session?: { currentQuestion?: string; currentQuestionIndex?: number; maxQuestions?: number } }).session;
        if (nextSession != null && nextSession.currentQuestion) {
          const q = nextSession.currentQuestion;
          const qIndex = nextSession.currentQuestionIndex;
          const qMax = nextSession.maxQuestions;
          const applyNextQuestion = () => {
            queryClient.setQueryData(
              ['voice-interview-session', sessionId],
              (old: { session?: Record<string, unknown> } | undefined) =>
                old?.session
                  ? { session: { ...old.session, currentQuestion: q, currentQuestionIndex: qIndex ?? old.session.currentQuestionIndex, maxQuestions: qMax ?? old.session.maxQuestions } }
                  : old
            );
            lastSpokenQuestionRef.current = null;
            setIsAIThinking(false);
          };
          if (wasSilenceCheck) {
            applyNextQuestion();
          } else {
            setIsAIThinking(true);
            const thinkingDelay = AI_THINKING_DELAY_MIN_MS + Math.random() * (AI_THINKING_DELAY_MAX_MS - AI_THINKING_DELAY_MIN_MS);
            setTimeout(applyNextQuestion, thinkingDelay);
          }
        } else {
          queryClient.setQueryData(
            ['voice-interview-session', sessionId],
            (old: { session?: Record<string, unknown> } | undefined) =>
              old?.session && nextSession != null
                ? { session: { ...old.session, currentQuestion: nextSession.currentQuestion ?? old.session.currentQuestion, currentQuestionIndex: nextSession.currentQuestionIndex ?? old.session.currentQuestionIndex, maxQuestions: nextSession.maxQuestions ?? old.session.maxQuestions } }
                : old
          );
          lastSpokenQuestionRef.current = null;
        }
        queryClient.invalidateQueries({ queryKey: ['voice-interview-session', sessionId] });
      }
      queryClient.invalidateQueries({ queryKey: ['candidate-voice-interviews'] });
    },
    onError: (e: any) => {
      submittingRef.current = false;
      toast({
        title: 'Could not submit answer',
        description: e?.message ?? 'Please try again.',
        variant: 'destructive',
      });
    },
  });

  /** Submit after ANSWER_COMPLETE_PAUSE_MS silence (answer complete). Does not run for initial idle; use runSilenceCheck for that. */
  const runAutoSubmit = useCallback(() => {
    if (submittingRef.current || submitMutation.isPending) return;
    if (vadTimerRef.current) {
      clearTimeout(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    const text = (latestResponseRef.current + ' ' + latestInterimRef.current).trim() || '(No response)';
    submittingRef.current = true;
    const expressionSummary = formatExpressionSummaryForOutcome(expressionSamples, cameraOn) || undefined;
    submitMutation.mutate({ text, expressionSummary });
  }, [submitMutation, expressionSamples, cameraOn]);

  /** Silence check: no speech for 8s or 15s → submit "(silence 8s)" or "(silence 15s)" and schedule next check. */
  const runSilenceCheck = useCallback(() => {
    if (submittingRef.current || submitMutation.isPending) return;
    if (isAISpeakingRef.current || Date.now() < ignoreResultsUntilRef.current) {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => silenceCheckRef.current(), 2000);
      return;
    }
    const phase = silenceCheckPhaseRef.current;
    const text = phase === 0 ? '(silence 8s)' : '(silence 15s)';
    silenceCheckPhaseRef.current = phase === 0 ? 1 : 0;
    const nextMs = phase === 0 ? SILENCE_CHECK_SECOND_MS : SILENCE_CHECK_FIRST_MS;
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => silenceCheckRef.current(), nextMs);
    submittingRef.current = true;
    submittedSilenceCheckRef.current = true;
    submitMutation.mutate({ text, expressionSummary: undefined });
  }, [submitMutation]);

  const autoSubmitRef = useRef(runAutoSubmit);
  autoSubmitRef.current = runAutoSubmit;
  const silenceCheckRef = useRef(runSilenceCheck);
  silenceCheckRef.current = runSilenceCheck;

  const SpeechRecognitionAPI = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
  const speechSupported = !!SpeechRecognitionAPI;

  /** Attach result/end/error handlers to a recognition instance so it captures voice and restarts correctly. */
  const attachRecognitionHandlers = useCallback((rec: any, langCode: string) => {
    rec.lang = LANG_BCP47[(langCode || 'en').split('-')[0]] || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    const scheduleAutoSubmit = () => {
      if (vadTimerRef.current) clearTimeout(vadTimerRef.current);
      vadTimerRef.current = setTimeout(() => autoSubmitRef.current(), ANSWER_COMPLETE_PAUSE_MS);
    };
    rec.onresult = (event: any) => {
      if (isAISpeakingRef.current || Date.now() < ignoreResultsUntilRef.current) return;
      lastSpeechActivityAtRef.current = Date.now();
      lastRecognitionResultAtRef.current = Date.now();
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0]?.transcript ?? '';
        if (event.results[i].isFinal) finalText += transcript + ' ';
        else interimText += transcript;
      }
      const combined = (finalText + interimText).trim();
      if (combined && looksLikeAIEcho(combined, lastSpokenQuestionRef.current)) return;
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      scheduleAutoSubmit();
      if (finalText.trim()) setResponse((prev) => (prev + finalText).trim());
      setInterimTranscript(interimText);
      latestResponseRef.current = (latestResponseRef.current + finalText).trim();
      latestInterimRef.current = interimText;
    };
    rec.onend = () => {
      if (restartingAfterTTSRef.current) return;
      if (isListeningRef.current && recognitionRef.current === rec) {
        try { rec.start(); } catch (_) {}
      }
    };
    rec.onerror = (e: any) => {
      if (e?.error === 'not-allowed') {
        setIsListening(false);
        setAudioEnabled(false);
        if (audioStreamRef.current) {
          audioStreamRef.current.getTracks().forEach((t) => t.stop());
          audioStreamRef.current = null;
        }
        toast({ title: 'Microphone blocked', description: 'Turn on Mic again and choose Allow when the browser asks.', variant: 'destructive' });
        return;
      }
      if (e?.error === 'no-speech' || e?.error === 'aborted') return;
      // Recover from transient SpeechRecognition failures that can stall auto-submit after a few turns.
      if (!isListeningRef.current || recognitionRef.current !== rec) return;
      setTimeout(() => {
        if (!isListeningRef.current || recognitionRef.current !== rec) return;
        try { rec.stop(); } catch (_) {}
        setTimeout(() => {
          if (!isListeningRef.current || recognitionRef.current !== rec) return;
          attachRecognitionHandlers(rec, langCode);
          try { rec.start(); } catch (_) {}
        }, 180);
      }, 120);
    };
  }, [toast]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!isListeningRef.current) return;
      if (isAISpeakingRef.current) return;
      if (Date.now() < ignoreResultsUntilRef.current) return;
      const hasDraft = (latestResponseRef.current + ' ' + latestInterimRef.current).trim().length > 0;
      const idleMs = Date.now() - lastSpeechActivityAtRef.current;
      if (hasDraft && idleMs > ANSWER_COMPLETE_PAUSE_MS + 1500 && !submittingRef.current && !submitMutation.isPending) {
        autoSubmitRef.current();
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [submitMutation.isPending]);

  const startListening = useCallback(async () => {
    if (!SpeechRecognitionAPI) {
      toast({ title: 'Voice input not supported', description: 'Use Chrome or Edge and allow microphone access.', variant: 'destructive' });
      return;
    }
    if (typeof navigator?.mediaDevices?.getUserMedia !== 'function') {
      toast({ title: 'Microphone not available', description: 'Open this page over HTTPS or localhost (e.g. http://localhost:5000).', variant: 'destructive' });
      return;
    }
    setIsListening(true);
    setAudioEnabled(true);
    setResponse('');
    setInterimTranscript('');
    latestResponseRef.current = '';
    latestInterimRef.current = '';
    lastSpeechActivityAtRef.current = Date.now();
    lastRecognitionResultAtRef.current = Date.now();
    silenceCheckPhaseRef.current = 0;
    const langCode = interviewLangRef.current || preferredLanguage || 'en';
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => silenceCheckRef.current(), SILENCE_CHECK_FIRST_MS);

    let stream = audioStreamRef.current;
    if (!stream?.active) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
        if (audioStreamRef.current) audioStreamRef.current.getTracks().forEach((t) => t.stop());
        audioStreamRef.current = stream;
      } catch (e: any) {
        setIsListening(false);
        setAudioEnabled(false);
        if (e?.name === 'NotAllowedError' || e?.message?.includes('Permission')) {
          toast({ title: 'Microphone access denied', description: 'Allow microphone in your browser to use voice input.', variant: 'destructive' });
        } else {
          toast({ title: 'Could not start voice input', description: 'Try again or type your answer.', variant: 'destructive' });
        }
        return;
      }
    }

    let rec = recognitionRef.current;
    if (!rec) {
      rec = new SpeechRecognitionAPI();
      recognitionRef.current = rec;
    } else {
      try { rec.stop(); } catch (_) {}
    }
    attachRecognitionHandlers(rec, langCode);
    try {
      rec.start();
    } catch (_) {
      setTimeout(() => {
        if (!isListeningRef.current || recognitionRef.current !== rec) return;
        try { rec.start(); } catch (_) {}
      }, 200);
    }
  }, [SpeechRecognitionAPI, toast, preferredLanguage, attachRecognitionHandlers]);

  // Keep reattach ref in sync so TTS onEnd can reattach the real onresult every time (fixes turn 2+ not capturing voice).
  useEffect(() => {
    reattachHandlersRef.current = attachRecognitionHandlers;
  }, [attachRecognitionHandlers]);

  // After TTS ends: restart the same recognition instance (stop then delayed start) so the mic keeps working every turn — like a real call.
  // Reusing one instance avoids browser issues from creating many recognition objects.
  const RESTART_RECOGNITION_DELAY_MS = 300;
  useEffect(() => {
    restartRecognitionAfterTTSRef.current = (langCode: string) => {
      if (!isListeningRef.current) return;
      const rec = recognitionRef.current;
      if (!rec) {
        ensureRecognitionActiveRef.current();
        return;
      }
      restartingAfterTTSRef.current = true;
      rec.onend = () => {}; // prevent onend from restarting while we do delayed start
      try { rec.stop(); } catch (_) {}
      setTimeout(() => {
        restartingAfterTTSRef.current = false;
        if (!isListeningRef.current) return;
        attachRecognitionHandlers(rec, langCode);
        recognitionRef.current = rec;
        try { rec.start(); } catch (_) {}
      }, RESTART_RECOGNITION_DELAY_MS);
    };
  }, [attachRecognitionHandlers]);

  // Keep STT alive: if mic is on but recognition died (e.g. after session refetch), restart it.
  useEffect(() => {
    ensureRecognitionActiveRef.current = () => {
      if (!isListeningRef.current || !SpeechRecognitionAPI) return;
      const langCode = interviewLangRef.current || 'en';
      const rec = recognitionRef.current;
      if (!rec) {
        const newRec = new SpeechRecognitionAPI();
        attachRecognitionHandlers(newRec, langCode);
        recognitionRef.current = newRec;
        try { newRec.start(); } catch (_) {}
        return;
      }
      attachRecognitionHandlers(rec, langCode);
      try { rec.start(); } catch (_) {}
    };
  }, [SpeechRecognitionAPI, attachRecognitionHandlers]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!isListeningRef.current || isAISpeakingRef.current) return;
      if (Date.now() < ignoreResultsUntilRef.current) return;
      const rec = recognitionRef.current;
      const streamActive = audioStreamRef.current?.active;
      if (!rec || !streamActive) {
        ensureRecognitionActiveRef.current();
        return;
      }
      const sinceResult = Date.now() - lastRecognitionResultAtRef.current;
      const sinceSpeech = Date.now() - lastSpeechActivityAtRef.current;
      if (sinceResult > 12000 && sinceSpeech > 12000 && !submittingRef.current) {
        const langCode = interviewLangRef.current || 'en';
        restartRecognitionAfterTTSRef.current(langCode);
        lastRecognitionResultAtRef.current = Date.now();
      }
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  const stopListening = useCallback(() => {
    setIsListening(false);
    setAudioEnabled(false);
    setInterimTranscript('');
    if (vadTimerRef.current) {
      clearTimeout(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (_) {}
      recognitionRef.current = null;
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((t) => t.stop());
      audioStreamRef.current = null;
    }
  }, []);

  const handlePlayQuestion = useCallback(() => {
    const q = session?.currentQuestion;
    if (!q) return;
    lastSpokenQuestionRef.current = q;
    setIsAISpeaking(true);
    const lang = interviewLangRef.current || preferredLanguage;
    void speakQuestion(q, () => setIsAISpeaking(false), lang || 'en', reportTtsError);
  }, [session?.currentQuestion, preferredLanguage, reportTtsError]);

  const handleEndInterview = useCallback(() => {
    stopListening();
    stopVoiceInterviewTTSPlayback();
    setLocation('/candidate/interviews');
  }, [stopListening, setLocation]);

  const requestCameraAndMic = useCallback(() => {
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: AUDIO_CONSTRAINTS.audio as MediaTrackConstraints })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
        toast({ title: 'Camera & microphone allowed', description: 'You can now start the interview and use video and voice.' });
      })
      .catch((err: any) => {
        if (err?.name === 'NotAllowedError') {
          toast({ title: 'Access denied', description: 'Allow camera and microphone in your browser (click the lock/info icon in the address bar).', variant: 'destructive' });
        } else {
          toast({ title: 'Could not access camera or mic', description: err?.message ?? 'Check browser settings.', variant: 'destructive' });
        }
      });
  }, [toast]);

  if (!sessionId || sessionQuery.isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-blue-900 to-purple-900 flex items-center justify-center">
        <Skeleton className="h-12 w-48 bg-white/10" />
      </div>
    );
  }

  if (sessionQuery.error || !session) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-blue-900 to-purple-900 flex items-center justify-center p-6">
        <div className="text-center text-white">
          <p className="text-red-400 mb-4">Session not found or expired.</p>
          <Link href="/candidate/interviews">
            <Button variant="outline" className="border-white/30 text-white hover:bg-white/10">Back to Interviews</Button>
          </Link>
        </div>
      </div>
    );
  }

  const expired = session.status === 'expired';
  const completed = session.status === 'completed';

  if (expired) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-blue-900 to-purple-900 flex items-center justify-center p-6">
        <div className="text-center text-white max-w-md">
          <p className="text-xl font-medium mb-2">{session.jobTitle}</p>
          <p className="text-gray-400 mb-4">This voice interview has expired.</p>
          <Link href="/candidate/interviews">
            <Button variant="outline" className="border-white/30 text-white hover:bg-white/10">Back to Interviews</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (completed) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-blue-900 to-purple-900 flex items-center justify-center p-6">
        <div className="text-center text-white max-w-md">
          <CheckCircle2 className="w-16 h-16 text-green-400 mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Interview complete</h1>
          <p className="text-gray-300 mb-6">You have completed the voice interview for {session.jobTitle}.</p>
          <div className="flex flex-wrap gap-3 justify-center">
            <Button onClick={() => setLocation(`/candidate/voice-interviews/${sessionId}/report`)} className="bg-blue-600 hover:bg-blue-700">
              View report
            </Button>
            <Link href="/candidate/interviews">
              <Button variant="outline" className="border-white/30 text-white hover:bg-white/10">Back to Interviews</Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Assigned: show start screen (simulator-style setup)
  if (session.status === 'assigned') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-blue-900 to-purple-900 flex items-center justify-center p-6">
        <div className="w-full max-w-2xl">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-white mb-2">Voice Interview</h1>
            <p className="text-gray-300">Get ready for your AI-powered interview</p>
          </div>
          <div className="bg-gray-800/80 backdrop-blur-xl rounded-3xl p-8 border border-gray-700 shadow-2xl">
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold text-white mb-2">{session.jobTitle}</h2>
                <p className="text-gray-400 text-sm mb-2">
                  You will hear {session.maxQuestions} questions and can answer by speaking or typing.
                </p>
                {browserSupport && (
                  <div className="rounded-lg border border-gray-600 bg-gray-900/60 p-3 text-sm space-y-2">
                    {!browserSupport.voice && (
                      <p className="text-amber-200">
                        Voice answers work best in <strong>Chrome or Edge</strong>. You can still do the interview and type your answers in other browsers.
                      </p>
                    )}
                    {browserSupport.voice && (
                      <p className="text-green-300/90">
                        Your browser supports voice. Allow the microphone when asked.
                      </p>
                    )}
                    {!browserSupport.media && (
                      <p className="text-amber-200">
                        Camera and microphone need a <strong>secure page</strong> (use https:// or http://localhost).
                      </p>
                    )}
                    <p className="text-gray-400 text-xs">
                      Browser issue? Use Chrome or Edge, allow mic (and camera if you want video) when the browser asks.
                    </p>
                  </div>
                )}
                {!browserSupport && (
                  <p className="text-amber-200/90 text-sm">
                    First allow camera and microphone so your video and voice work. Use Chrome or Edge for best support.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-white block">Interview language</label>
                <select
                  value={preferredLanguage}
                  onChange={(e) => setPreferredLanguage(e.target.value)}
                  className="w-full h-10 rounded-lg border border-gray-600 bg-gray-800 text-white px-3 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  {INTERVIEW_LANGUAGES.map((opt) => (
                    <option key={opt.value} value={opt.value} className="bg-gray-800">
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-400">The AI will speak and understand your answers in this language.</p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full border-white/40 text-white hover:bg-white/10 gap-2"
                onClick={requestCameraAndMic}
              >
                <Video className="w-5 h-5" />
                Enable camera & microphone
              </Button>
              <Button
                onClick={() => startMutation.mutate(undefined)}
                disabled={startMutation.isPending}
                className="w-full bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white font-bold py-4 rounded-xl gap-2"
              >
                {startMutation.isPending ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Starting…
                  </>
                ) : (
                  <>
                    <Mic className="w-5 h-5" />
                    Start Interview
                  </>
                )}
              </Button>
              <Link href="/candidate/interviews" className="block">
                <Button variant="ghost" className="w-full text-gray-400 hover:text-white gap-2">
                  <ArrowLeft className="w-4 h-4" />
                  Back to Interviews
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // In progress: simulator-style two-panel interview UI
  const currentQuestion = session.currentQuestion;
  const interviewEnded = timeExpired || session.status === 'expired';

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen bg-gray-900 overflow-y-auto flex flex-col">
      {interviewEnded && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-amber-900/90 text-amber-100 px-4 py-2 rounded-lg text-sm font-medium">
          Time&apos;s up. Interview closed. You can no longer submit answers.
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 p-4 min-h-0">
        {/* AI Interviewer panel — human-like avatar */}
        <div className="relative bg-gray-800 rounded-2xl overflow-hidden border border-gray-700 flex items-center justify-center">
          <div className="absolute inset-0 bg-gradient-to-br from-slate-800/80 to-slate-900/80" />
          <div
            className={`relative flex items-center justify-center transition-transform duration-300 ${
              isAISpeaking ? 'scale-105' : 'scale-100'
            }`}
          >
            <div
              className={`relative w-40 h-40 rounded-full overflow-hidden border-4 shadow-2xl ${
                isAISpeaking
                  ? 'border-green-500/60 ring-4 ring-green-500/30 animate-pulse'
                  : 'border-slate-600'
              }`}
            >
              <img
                src="https://api.dicebear.com/7.x/avataaars/svg?seed=Aria"
                alt="Interviewer"
                className="w-full h-full object-cover object-top"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                  (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                }}
              />
              <div className="hidden absolute inset-0 bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <Volume2 className="w-16 h-16 text-white/90" />
              </div>
              {isAISpeaking && (
                <div className="absolute inset-0 bg-green-500/10 pointer-events-none" />
              )}
            </div>
          </div>
          <div className="absolute top-4 left-4 flex items-center gap-2 bg-black/50 backdrop-blur-sm rounded-full px-4 py-2">
            <div className={`w-2 h-2 rounded-full ${isAISpeaking ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
            <span className="text-sm font-medium text-white">Aria — Interviewer</span>
          </div>
          <div className="absolute top-4 right-4 flex items-center gap-2">
            {remainingSeconds !== null && remainingSeconds > 0 && (
              <span className="bg-black/50 backdrop-blur-sm rounded-lg px-3 py-1.5 text-sm font-mono text-white">
                {formatTime(remainingSeconds)} left
              </span>
            )}
          </div>
          {isAISpeaking && (
            <div className="absolute bottom-4 left-4 bg-black/50 backdrop-blur-sm rounded-lg px-4 py-2">
              <div className="text-xs text-green-400">Speaking…</div>
              <div className="flex gap-1 mt-1">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div
                    key={i}
                    className="w-1 bg-green-400 rounded-full animate-pulse"
                    style={{ height: `${10 + Math.random() * 20}px`, animationDelay: `${i * 0.1}s` }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Candidate video panel */}
        <div className="relative bg-gray-800 rounded-2xl overflow-hidden border border-gray-700">
          {cameraOn ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
              style={{ transform: 'scaleX(-1)' }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gray-900">
              <div className="text-center text-gray-500">
                <VideoOff className="w-16 h-16 mx-auto mb-2 opacity-50" />
                <p className="text-sm">Camera off</p>
              </div>
            </div>
          )}
          <div className="absolute top-4 left-4 flex items-center gap-2 bg-black/50 backdrop-blur-sm rounded-full px-4 py-2">
            <div className={`w-2 h-2 rounded-full ${isListening && audioEnabled ? 'bg-red-500 animate-pulse' : 'bg-gray-500'}`} />
            <span className="text-sm font-medium text-white">You</span>
          </div>
          {isListening && audioEnabled && (
            <div className="absolute bottom-4 right-4 bg-black/50 backdrop-blur-sm rounded-lg px-4 py-2">
              <div className="text-xs text-gray-300">
                {speechSupported ? 'Listening…' : 'Type your answer below'}
              </div>
            </div>
          )}
          {cameraOn && (
            <div className="absolute bottom-4 left-4 bg-green-900/50 backdrop-blur-sm rounded-lg px-3 py-1.5">
              <div className="text-xs text-green-300">
                {expressionSamples.length > 0
                  ? `Demeanor: ${expressionSamples[expressionSamples.length - 1].summary}`
                  : 'Camera on — demeanor noted'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Question and response area - above the control bar */}
      <div className="absolute bottom-16 left-0 right-0 z-20 px-4 pb-4 pt-2 bg-gradient-to-t from-gray-900 to-transparent">
        <div className="max-w-4xl mx-auto space-y-3">
          <div className="bg-gray-800/95 backdrop-blur-xl rounded-2xl p-4 border border-gray-700 shadow-xl">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center">
                <Volume2 className="w-5 h-5 text-blue-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white font-medium leading-relaxed">
                  {isAIThinking ? 'Thinking…' : currentQuestion || (submitMutation.isPending ? 'Loading…' : '')}
                </p>
                {currentQuestion && !isAIThinking && (
                  <button
                    type="button"
                    onClick={handlePlayQuestion}
                    disabled={isAISpeaking}
                    className="mt-2 text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1"
                  >
                    {isAISpeaking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Volume2 className="w-4 h-4" />}
                    {isAISpeaking ? 'Playing…' : 'Play question again'}
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="bg-green-500/10 backdrop-blur-xl rounded-2xl p-4 border border-green-500/30">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-3 h-3 mt-2 rounded-full bg-green-500 animate-pulse" />
              <div className="flex-1 min-w-0 space-y-2">
                <div className="text-sm text-green-400 font-medium flex items-center gap-2 flex-wrap">
                  <Mic className="w-4 h-4" />
                  {speechSupported
                    ? 'Turn on Mic to speak. Your answer is sent automatically after 2.5 seconds of silence (natural pauses are fine). Say "my mic is not working" to offer reschedule.'
                    : 'Voice only — use a browser that supports speech (Chrome/Edge).'}
                </div>
                <p className="text-xs text-gray-500">
                  Camera or mic not working? Say so and we can reschedule. Use Chrome/Edge and allow camera &amp; mic when the browser asks.
                </p>
                <div
                  className="w-full bg-gray-900 text-white border border-gray-700 rounded-lg p-3 resize-none text-sm min-h-[80px] cursor-default select-text"
                  aria-label="Voice-to-text transcript (read-only)"
                >
                  <p className="text-gray-300 whitespace-pre-wrap break-words min-h-[4rem]">
                    {response + (isListening && audioEnabled && interimTranscript ? interimTranscript : '') || (speechSupported ? 'Your speech will appear here. Answer is sent automatically after 2.5 seconds of silence.' : '—')}
                  </p>
                </div>
                {submitMutation.isPending && (
                  <div className="flex items-center gap-2 text-sm text-amber-400">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Sending…
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Control bar - Mic and Camera fixed at bottom */}
      <div className="absolute bottom-0 left-0 right-0 z-30 bg-gray-900/95 border-t border-gray-700 py-3 px-4 flex items-center justify-center gap-6">
        <button
          type="button"
          onClick={() => {
            if (audioEnabled) {
              stopListening();
              setAudioEnabled(false);
            } else {
              setAudioEnabled(true);
              startListening();
            }
          }}
          title={audioEnabled ? 'Turn off mic (stop voice input)' : 'Turn on mic (speak your answer)'}
          className={`flex flex-col items-center gap-1 min-w-[64px] py-2 px-4 rounded-xl transition-all ${
            audioEnabled ? 'bg-gray-700 hover:bg-gray-600 text-white' : 'bg-red-600 hover:bg-red-500 text-white'
          }`}
        >
          {audioEnabled ? <Mic className="w-6 h-6" /> : <MicOff className="w-6 h-6" />}
          <span className="text-xs font-medium">Mic</span>
        </button>
        <button
          type="button"
          onClick={() => setCameraOn((c) => !c)}
          title={cameraOn ? 'Turn off camera' : 'Turn on camera'}
          className={`flex flex-col items-center gap-1 min-w-[64px] py-2 px-4 rounded-xl transition-all ${
            cameraOn ? 'bg-gray-700 hover:bg-gray-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
          }`}
        >
          {cameraOn ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
          <span className="text-xs font-medium">Camera</span>
        </button>
        <span className="text-xs text-gray-500 hidden sm:inline">Complete the interview to finish</span>
      </div>
    </div>
  );
}

export default VoiceInterviewRoom;
