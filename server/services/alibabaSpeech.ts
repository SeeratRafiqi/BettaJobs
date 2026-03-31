/**
 * Alibaba DashScope Speech: TTS (and optional ASR) for voice interview flow.
 * Uses the same API key as Qwen (ALIBABA_LLM_API_KEY / DASHSCOPE_API_KEY).
 *
 * TTS: qwen3-tts-flash — better quality and language support than browser SpeechSynthesis.
 *
 * ASR (future): Real-time speech-to-text via Fun-ASR WebSocket
 * (wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference/) with run-task → stream
 * binary 16kHz WAV → finish-task; same key. Could add a backend WebSocket proxy so
 * the client streams mic audio to our server, which forwards to DashScope and returns text.
 */

import axios from 'axios';

const DASHSCOPE_TTS_URL =
  process.env.ALIBABA_TTS_BASE_URL ||
  'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

const LANGUAGE_TO_TTS: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  hi: 'Hindi',
  pt: 'Portuguese',
  ar: 'Arabic',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  it: 'Italian',
  ru: 'Russian',
};

export function isAlibabaSpeechAvailable(): boolean {
  const key = process.env.ALIBABA_LLM_API_KEY || process.env.DASHSCOPE_API_KEY || '';
  return !!key.trim();
}

/**
 * Map our language code to DashScope language_type. Uses "Auto" if not in the list.
 */
function getLanguageType(languageCode: string): string {
  const code = (languageCode || 'en').split('-')[0];
  return LANGUAGE_TO_TTS[code] || 'Auto';
}

/**
 * Synthesize speech via Alibaba Qwen TTS. Returns audio as Buffer (WAV) for streaming to client.
 */
export async function synthesizeSpeech(
  text: string,
  languageCode: string
): Promise<{ audioBuffer: Buffer; mimeType: string } | null> {
  const apiKey = process.env.ALIBABA_LLM_API_KEY || process.env.DASHSCOPE_API_KEY;
  if (!apiKey?.trim()) {
    return null;
  }

  const languageType = getLanguageType(languageCode);
  // Short lines (greetings, acknowledgements) often sound stretched at a single global speed; nudge faster for brief text only.
  const rawText = (text || '').trim().slice(0, 2000);
  const normalizedText = rawText.replace(/\s+/g, ' ').replace(/\.{4,}/g, '...');
  const speed =
    normalizedText.length <= 90 ? 1.35 : normalizedText.length <= 220 ? 1.22 : 1.15;

  const body = {
    model: 'qwen3-tts-flash',
    input: {
      text: normalizedText,
      voice: 'loongstella',
      language_type: languageType,
    },
    parameters: {
      speed,
    },
  };

  const post = (b: typeof body) =>
    axios.post<{
      output?: { audio?: { url?: string; data?: string } };
      code?: string;
      message?: string;
    }>(DASHSCOPE_TTS_URL, b, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

  try {
    const response = await post(body);

    const audio = response.data?.output?.audio;
    if (!audio) {
      console.warn('[AlibabaSpeech] TTS response missing output.audio:', response.data?.code, response.data?.message);
      return null;
    }

    if (audio.data) {
      const buffer = Buffer.from(audio.data, 'base64');
      return { audioBuffer: buffer, mimeType: 'audio/wav' };
    }

    if (audio.url) {
      const audioRes = await axios.get(audio.url, { responseType: 'arraybuffer', timeout: 15000 });
      const buffer = Buffer.from(audioRes.data);
      return { audioBuffer: buffer, mimeType: 'audio/wav' };
    }

    return null;
  } catch (err: any) {
    const data = err?.response?.data;
    const msg = String(data?.message || err?.message || '');
    const code = String(data?.code || '');

    // If requested voice is not licensed/available, retry with a known-working fallback voice.
    if (code === 'InvalidParameter' && /invalid voice/i.test(msg)) {
      try {
        console.warn('[AlibabaSpeech] Voice not available; retrying with fallback voice.');
        const retry = {
          ...body,
          input: { ...body.input, voice: 'Cherry' },
        };
        const retryRes = await post(retry);
        const audio = retryRes.data?.output?.audio;
        if (!audio) return null;
        if (audio.data) {
          const buffer = Buffer.from(audio.data, 'base64');
          return { audioBuffer: buffer, mimeType: 'audio/wav' };
        }
        if (audio.url) {
          const audioRes = await axios.get(audio.url, { responseType: 'arraybuffer', timeout: 15000 });
          const buffer = Buffer.from(audioRes.data);
          return { audioBuffer: buffer, mimeType: 'audio/wav' };
        }
        return null;
      } catch (retryErr: any) {
        console.error('[AlibabaSpeech] TTS retry error:', retryErr?.response?.data || retryErr?.message);
        return null;
      }
    }

    console.error('[AlibabaSpeech] TTS error:', data || err?.message);
    return null;
  }
}
