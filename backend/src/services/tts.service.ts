import textToSpeech from '@google-cloud/text-to-speech';
import ffmpeg from './ffmpeg.js';
import fs from 'fs/promises';
import path from 'path';
import { getAuthMode, getGenerateContentEndpoint } from './google-auth.js';

// ---------------------------------------------------------------------------
// Available voices (per auth mode)
// ---------------------------------------------------------------------------

export const CLOUD_TTS_VOICES = [
  { id: 'en-US-Journey-D', name: 'Journey D (Male)', gender: 'MALE' },
  { id: 'en-US-Journey-F', name: 'Journey F (Female)', gender: 'FEMALE' },
  { id: 'en-US-Journey-O', name: 'Journey O (Female)', gender: 'FEMALE' },
  { id: 'en-US-Casual-K', name: 'Casual K (Male)', gender: 'MALE' },
  { id: 'en-US-Neural2-A', name: 'Neural2 A (Male)', gender: 'MALE' },
  { id: 'en-US-Neural2-C', name: 'Neural2 C (Female)', gender: 'FEMALE' },
  { id: 'en-US-Neural2-D', name: 'Neural2 D (Male)', gender: 'MALE' },
  { id: 'en-US-Neural2-F', name: 'Neural2 F (Female)', gender: 'FEMALE' },
  { id: 'en-US-Studio-M', name: 'Studio M (Male)', gender: 'MALE' },
  { id: 'en-US-Studio-O', name: 'Studio O (Female)', gender: 'FEMALE' },
];

// Gemini TTS prebuilt voices (subset — the API offers ~30)
export const GEMINI_TTS_VOICES = [
  { id: 'Puck', name: 'Puck (Upbeat)', gender: 'MALE' },
  { id: 'Charon', name: 'Charon (Informative)', gender: 'MALE' },
  { id: 'Fenrir', name: 'Fenrir (Excitable)', gender: 'MALE' },
  { id: 'Orus', name: 'Orus (Firm)', gender: 'MALE' },
  { id: 'Kore', name: 'Kore (Firm)', gender: 'FEMALE' },
  { id: 'Aoede', name: 'Aoede (Breezy)', gender: 'FEMALE' },
  { id: 'Leda', name: 'Leda (Youthful)', gender: 'FEMALE' },
  { id: 'Zephyr', name: 'Zephyr (Bright)', gender: 'FEMALE' },
];

export function getAvailableVoices() {
  try {
    return getAuthMode() === 'vertex' ? CLOUD_TTS_VOICES : GEMINI_TTS_VOICES;
  } catch {
    // No credentials configured yet — still let the UI render a voice list
    return GEMINI_TTS_VOICES;
  }
}

export function getDefaultVoice(): string {
  return getAvailableVoices()[0].id;
}

// ---------------------------------------------------------------------------
// Cloud TTS (Vertex / ADC mode)
// ---------------------------------------------------------------------------

let _ttsClient: InstanceType<typeof textToSpeech.TextToSpeechClient> | null = null;
function getTtsClient() {
  if (!_ttsClient) {
    _ttsClient = new textToSpeech.TextToSpeechClient();
  }
  return _ttsClient;
}

async function generateVoiceoverCloud(opts: {
  script: string;
  voice: string;
  outputDir: string;
  clipId: string;
}): Promise<string> {
  const { script, voice, outputDir, clipId } = opts;

  const [response] = await getTtsClient().synthesizeSpeech({
    input: { text: script },
    voice: {
      languageCode: 'en-US',
      name: voice,
    },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: 1.0,
      pitch: 0,
    },
  });

  if (!response.audioContent) {
    throw new Error('TTS returned empty audio content');
  }

  const audioPath = path.join(outputDir, `${clipId}_voiceover.mp3`);
  await fs.writeFile(audioPath, response.audioContent as Buffer);

  console.log(`[tts/cloud] Voiceover saved: ${audioPath}`);
  return audioPath;
}

// ---------------------------------------------------------------------------
// Gemini TTS (API-key mode)
// ---------------------------------------------------------------------------

async function generateVoiceoverGemini(opts: {
  script: string;
  voice: string;
  outputDir: string;
  clipId: string;
}): Promise<string> {
  const { script, voice, outputDir, clipId } = opts;

  const model = process.env.TTS_MODEL || 'gemini-3.1-flash-tts-preview';
  const { url, headers } = await getGenerateContentEndpoint(model);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: script }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Gemini TTS error: ${response.status} ${errorText.slice(0, 300)}`,
    );
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const json = (await response.json()) as Record<string, any>;
  const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
  const base64 = parts.find((p) => p?.inlineData?.data)?.inlineData?.data;

  if (!base64) {
    throw new Error('Gemini TTS returned no audio data');
  }

  // Gemini TTS returns raw 24 kHz mono PCM16LE — wrap it into an MP3 with
  // ffmpeg so downstream muxing treats it like any other audio file.
  const pcmPath = path.join(outputDir, `${clipId}_voiceover.pcm`);
  await fs.writeFile(pcmPath, Buffer.from(base64, 'base64'));

  const audioPath = path.join(outputDir, `${clipId}_voiceover.mp3`);
  await new Promise<void>((resolve, reject) => {
    ffmpeg(pcmPath)
      .inputOptions(['-f s16le', '-ar 24000', '-ac 1'])
      .audioCodec('libmp3lame')
      .output(audioPath)
      .on('end', () => resolve())
      .on('error', (err: Error) =>
        reject(new Error(`FFmpeg PCM→MP3 failed: ${err.message}`)),
      )
      .run();
  });
  await fs.unlink(pcmPath).catch(() => {});

  console.log(`[tts/gemini] Voiceover saved: ${audioPath}`);
  return audioPath;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synthesize a voiceover audio file from a script.
 *
 * Uses Cloud Text-to-Speech in Vertex mode (ADC available) and the Gemini
 * TTS API in API-key mode.
 */
export async function generateVoiceover(opts: {
  script: string;
  voice: string;
  outputDir: string;
  clipId: string;
}): Promise<string> {
  return getAuthMode() === 'vertex'
    ? generateVoiceoverCloud(opts)
    : generateVoiceoverGemini(opts);
}
