import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs/promises';

/**
 * Merge a raw video (no audio) with a voiceover MP3 into a final MP4.
 */
export function muxVideoAudio(opts: {
  videoPath: string;
  audioPath: string;
  outputDir: string;
  clipId: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const { videoPath, audioPath, outputDir, clipId } = opts;
    const outputPath = path.join(outputDir, `${clipId}_final.mp4`);

    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v copy',
        '-c:a aac',
        '-map 0:v:0',
        '-map 1:a:0',
        '-shortest',
      ])
      .output(outputPath)
      .on('start', (cmd) => console.log(`[ffmpeg] ${cmd}`))
      .on('end', () => {
        console.log(`[ffmpeg] Muxed output saved: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err: Error) =>
        reject(new Error(`FFmpeg mux failed: ${err.message}`)),
      )
      .run();
  });
}

/**
 * Concatenate multiple video segments into a single MP4 using FFmpeg concat demuxer.
 */
export async function concatenateVideos(opts: {
  videoPaths: string[];
  outputDir: string;
  clipId: string;
}): Promise<string> {
  const { videoPaths, outputDir, clipId } = opts;

  if (videoPaths.length === 1) return videoPaths[0];

  // Write concat list file
  const listPath = path.join(outputDir, `${clipId}_concat.txt`);
  const listContent = videoPaths
    .map((p) => `file '${path.resolve(p)}'`)
    .join('\n');
  await fs.writeFile(listPath, listContent);

  const outputPath = path.join(outputDir, `${clipId}_joined.mp4`);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy'])
      .output(outputPath)
      .on('start', (cmd) => console.log(`[ffmpeg] ${cmd}`))
      .on('end', async () => {
        console.log(`[ffmpeg] Concatenated ${videoPaths.length} segments → ${outputPath}`);
        // Clean up concat list file
        try { await fs.unlink(listPath); } catch { /* ignore */ }
        resolve(outputPath);
      })
      .on('error', (err: Error) =>
        reject(new Error(`FFmpeg concat failed: ${err.message}`)),
      )
      .run();
  });
}

/**
 * Extract the last frame from a video as a JPEG image for chaining.
 */
export function extractLastFrame(opts: {
  videoPath: string;
  outputDir: string;
  clipId: string;
  segmentIndex: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const { videoPath, outputDir, clipId, segmentIndex } = opts;
    const framePath = path.join(outputDir, `${clipId}_seg${segmentIndex}_lastframe.jpg`);

    // Use sseof to seek to near the end, then grab 1 frame
    ffmpeg(videoPath)
      .inputOptions(['-sseof', '-0.1'])
      .outputOptions(['-frames:v', '1', '-q:v', '2'])
      .output(framePath)
      .on('end', () => {
        console.log(`[ffmpeg] Last frame extracted: ${framePath}`);
        resolve(framePath);
      })
      .on('error', (err: Error) =>
        reject(new Error(`FFmpeg frame extraction failed: ${err.message}`)),
      )
      .run();
  });
}
