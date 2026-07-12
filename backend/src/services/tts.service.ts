import textToSpeech from '@google-cloud/text-to-speech';
import fs from 'fs/promises';
import path from 'path';

const ttsClient = new textToSpeech.TextToSpeechClient();

/**
 * Synthesize a voiceover audio file from a script using Cloud Text-to-Speech.
 */
export async function generateVoiceover(opts: {
  script: string;
  voice: string;
  outputDir: string;
  clipId: string;
}): Promise<string> {
  const { script, voice, outputDir, clipId } = opts;

  const [response] = await ttsClient.synthesizeSpeech({
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

  const audioFileName = `${clipId}_voiceover.mp3`;
  const audioPath = path.join(outputDir, audioFileName);
  await fs.writeFile(audioPath, response.audioContent as Buffer);

  console.log(`[tts] Voiceover saved: ${audioPath}`);
  return audioPath;
}
