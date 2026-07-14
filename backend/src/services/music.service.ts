import fs from 'fs/promises';
import path from 'path';
import ffmpeg from './ffmpeg.js';
import { getAuthMode } from './google-auth.js';

// ---------------------------------------------------------------------------
// Generate background music via Lyria 3 Clip (always 30s)
// ---------------------------------------------------------------------------

/**
 * Generate background music using the Lyria 3 Clip model.
 *
 * The model always produces a 30-second MP3 clip. If the video is longer,
 * the music is looped and trimmed to match the video duration via ffmpeg.
 */
export async function generateBackgroundMusic(opts: {
  narrationScript: string;
  musicPrompt?: string; // user-editable prompt — if provided, used directly
  videoDuration: number; // seconds — used to loop/trim the clip
  outputDir: string;
  clipId: string;
}): Promise<string> {
  const { narrationScript, musicPrompt: userMusicPrompt, videoDuration, outputDir, clipId } = opts;

  // Use the user's music prompt if provided, otherwise build a default one
  const musicPrompt = userMusicPrompt?.trim()
    ? userMusicPrompt.trim()
    : `Soft, atmospheric instrumental background music suitable for a documentary narration video. ` +
      `No vocals, no lyrics. The mood should complement this narration: "${narrationScript.slice(0, 300)}…". ` +
      `Gentle, ambient, cinematic underscore with minimal percussion.`;

  const mode = getAuthMode();

  let base64Audio: string;

  if (mode === 'gemini') {
    // Gemini API key mode — use the Interactions endpoint
    const apiKey = process.env.GEMINI_API_KEY!;
    const url = `https://generativelanguage.googleapis.com/v1beta/interactions`;

    console.log(`[music] Generating background music via Lyria 3 Clip…`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        model: 'lyria-3-clip-preview',
        input: musicPrompt,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Lyria music generation failed: ${response.status} ${errorText.slice(0, 300)}`,
      );
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const json = (await response.json()) as Record<string, any>;

    // Extract audio from the steps → model_output → content → audio blocks
    const steps: any[] = json?.steps ?? [];
    let audioData: string | null = null;
    for (const step of steps) {
      if (step?.type === 'model_output') {
        for (const block of step?.content ?? []) {
          if (block?.type === 'audio' && block?.data) {
            audioData = block.data;
          }
        }
      }
    }

    if (!audioData) {
      throw new Error('Lyria returned no audio data');
    }

    base64Audio = audioData;
  } else {
    // Vertex AI mode — not yet supported for Lyria
    throw new Error(
      'Background music generation requires a Gemini API key (Lyria is not available on Vertex AI)',
    );
  }

  // Save the raw 30s clip
  const rawMusicPath = path.join(outputDir, `${clipId}_music_raw.mp3`);
  await fs.writeFile(rawMusicPath, Buffer.from(base64Audio, 'base64'));
  console.log(`[music] Raw 30s music clip saved: ${rawMusicPath}`);

  // If the video is longer than 30s, loop the music to cover the full duration
  const musicPath = path.join(outputDir, `${clipId}_music.mp3`);

  if (videoDuration <= 30) {
    // Just trim to exact video duration
    await new Promise<void>((resolve, reject) => {
      ffmpeg(rawMusicPath)
        .duration(videoDuration)
        .output(musicPath)
        .on('end', () => resolve())
        .on('error', (err: Error) =>
          reject(new Error(`FFmpeg music trim failed: ${err.message}`)),
        )
        .run();
    });
  } else {
    // Loop and trim: -stream_loop -1 loops indefinitely, -t trims to duration
    await new Promise<void>((resolve, reject) => {
      ffmpeg(rawMusicPath)
        .inputOptions(['-stream_loop', '-1'])
        .duration(videoDuration)
        .audioCodec('libmp3lame')
        .output(musicPath)
        .on('end', () => resolve())
        .on('error', (err: Error) =>
          reject(new Error(`FFmpeg music loop failed: ${err.message}`)),
        )
        .run();
    });
  }

  // Clean up raw file
  await fs.unlink(rawMusicPath).catch(() => {});

  console.log(
    `[music] Background music ready (${videoDuration.toFixed(0)}s): ${musicPath}`,
  );
  return musicPath;
}
