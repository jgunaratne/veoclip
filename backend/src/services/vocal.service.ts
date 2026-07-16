import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import ffmpeg from './ffmpeg.js';

// Demucs (ML source separation) lives in its own python venv — see
// backend/.demucs-venv. It splits audio into "vocals" and everything else,
// removing music/ambience even underneath active speech, which a noise
// suppressor like RNNoise cannot do.
const DEMUCS_PYTHON = process.env.DEMUCS_PYTHON || './.demucs-venv/bin/python';

export async function demucsAvailable(): Promise<boolean> {
  try {
    await fs.access(DEMUCS_PYTHON);
    return true;
  } catch {
    return false;
  }
}

function runFfmpeg(configure: (cmd: ffmpeg.FfmpegCommand) => ffmpeg.FfmpegCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    configure(ffmpeg())
      .on('start', (c) => console.log(`[ffmpeg] ${c}`))
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}

/**
 * Replace a video's audio with the Demucs-separated vocals-only stem.
 * Returns the original path unchanged if Demucs is not installed, so callers
 * can use this best-effort. Throws on actual separation/mux failures.
 */
export async function separateVocals(opts: {
  videoPath: string;
  outputDir: string;
  clipId: string;
}): Promise<string> {
  const { videoPath, outputDir, clipId } = opts;

  if (!(await demucsAvailable())) {
    console.warn(`[vocal] Demucs python not found at ${DEMUCS_PYTHON} — skipping vocal separation`);
    return videoPath;
  }

  const wavPath = path.join(outputDir, `${clipId}_audio.wav`);
  const sepDir = path.join(outputDir, `${clipId}_demucs`);
  const outputPath = path.join(outputDir, `${clipId}_vocals.mp4`);

  try {
    // 1. Extract the audio track as PCM for demucs
    await runFfmpeg((cmd) =>
      cmd
        .input(videoPath)
        .outputOptions(['-vn', '-acodec pcm_s16le', '-ar 44100'])
        .output(wavPath),
    );

    // 2. Separate vocals from everything else
    console.log(`[vocal] Running demucs vocal separation for clip ${clipId}`);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(DEMUCS_PYTHON, [
        '-m', 'demucs.separate',
        '--two-stems=vocals',
        '-o', sepDir,
        wavPath,
      ]);
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += String(d); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`demucs exited with code ${code}: ${stderr.slice(-500)}`));
      });
    });

    const vocalsWav = path.join(sepDir, 'htdemucs', `${clipId}_audio`, 'vocals.wav');
    await fs.access(vocalsWav);

    // 3. Remux the untouched video stream with the vocals-only audio
    await runFfmpeg((cmd) =>
      cmd
        .input(videoPath)
        .input(vocalsWav)
        .outputOptions(['-map 0:v:0', '-map 1:a:0', '-c:v copy', '-c:a aac', '-b:a 192k', '-shortest'])
        .output(outputPath),
    );

    console.log(`[vocal] Vocal separation done: ${outputPath}`);
    return outputPath;
  } finally {
    // Clean up intermediates regardless of outcome
    await fs.unlink(wavPath).catch(() => {});
    await fs.rm(sepDir, { recursive: true, force: true }).catch(() => {});
  }
}
