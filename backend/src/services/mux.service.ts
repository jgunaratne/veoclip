import ffmpeg from './ffmpeg.js';
import path from 'path';
import fs from 'fs/promises';

/**
 * Get the duration of a media file in seconds via ffprobe.
 */
function getMediaDuration(mediaPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(mediaPath, (err, metadata) => {
      if (err) {
        reject(new Error(`ffprobe failed for ${mediaPath}: ${err.message}`));
        return;
      }
      resolve(metadata.format.duration ?? 0);
    });
  });
}

/**
 * Check if a media file has an audio track.
 */
function hasAudioStream(mediaPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(mediaPath, (err, metadata) => {
      if (err) {
        resolve(false);
        return;
      }
      const streams = metadata.streams ?? [];
      const hasAudio = streams.some((s) => s.codec_type === 'audio');
      resolve(hasAudio);
    });
  });
}

/**
 * Build an atempo filter for the given speed-up ratio. A single atempo is
 * limited to [0.5, 2.0], so larger ratios are chained.
 */
function atempoChain(ratio: number): string {
  const stages: string[] = [];
  let remaining = ratio;
  while (remaining > 2.0) {
    stages.push('atempo=2.0');
    remaining /= 2.0;
  }
  stages.push(`atempo=${remaining.toFixed(4)}`);
  return stages.join(',');
}

/**
 * Merge a raw video (no audio) with a voiceover into a final MP4.
 *
 * If the narration runs past the video, the audio is time-scaled to fit
 * instead of being chopped off mid-sentence.
 */
export async function muxVideoAudio(opts: {
  videoPath: string;
  audioPath?: string;
  backgroundMusicPath?: string;
  outputDir: string;
  clipId: string;
}): Promise<string> {
  const { videoPath, audioPath, backgroundMusicPath, outputDir, clipId } = opts;
  const outputPath = path.join(outputDir, `${clipId}_final.mp4`);

  // Handle case where voiceover narration is disabled
  if (!audioPath) {
    if (backgroundMusicPath) {
      const hasVideoAudio = await hasAudioStream(videoPath);
      console.log(`[ffmpeg] Muxing video (hasAudio=${hasVideoAudio}) + background music (no narration)`);

      return new Promise((resolve, reject) => {
        const cmd = ffmpeg().input(videoPath).input(backgroundMusicPath);

        if (hasVideoAudio) {
          // Mix video's original audio with music
          cmd
            .complexFilter('[0:a:0]volume=1.0[v_audio];[1:a:0]volume=0.12[music];[v_audio][music]amix=inputs=2:duration=first[aout]')
            .outputOptions([
              '-c:v copy',
              '-c:a aac',
              '-map 0:v:0',
              '-map [aout]',
            ]);
        } else {
          // No audio on video, just map background music directly
          cmd.outputOptions([
            '-c:v copy',
            '-c:a aac',
            '-map 0:v:0',
            '-map 1:a:0',
            '-shortest',
          ]);
        }

        cmd
          .output(outputPath)
          .on('start', (c) => console.log(`[ffmpeg] ${c}`))
          .on('end', () => {
            console.log(`[ffmpeg] Muxed video (music only) saved: ${outputPath}`);
            resolve(outputPath);
          })
          .on('error', (err: Error) =>
            reject(new Error(`FFmpeg mux failed: ${err.message}`)),
          )
          .run();
      });
    }

    // No voiceover, no background music — output is just the raw video file
    console.log(`[ffmpeg] Narration and music disabled, copying raw video directly`);
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .outputOptions(['-c copy'])
        .output(outputPath)
        .on('start', (c) => console.log(`[ffmpeg] ${c}`))
        .on('end', () => {
          console.log(`[ffmpeg] Saved final raw video copy: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (err: Error) =>
          reject(new Error(`FFmpeg copy failed: ${err.message}`)),
        )
        .run();
    });
  }

  // Voiceover narration IS enabled — run original muxing logic
  const [videoDuration, audioDuration] = await Promise.all([
    getMediaDuration(videoPath),
    getMediaDuration(audioPath),
  ]);

  // When background music is provided, mix narration + music using ffmpeg
  // complex filter. Music is at ~12% volume (-18dB) so it doesn't overpower
  // the narration.
  if (backgroundMusicPath) {
    // Complex filter: time-scale narration if needed, lower music volume,
    // then mix them together
    const complexFilter = audioDuration > videoDuration && videoDuration > 0
      ? `[1:a]${atempoChain(audioDuration / videoDuration)}[narr];[2:a]volume=0.12[music];[narr][music]amix=inputs=2:duration=shortest:dropout_transition=2[aout]`
      : `[1:a]anull[narr];[2:a]volume=0.12[music];[narr][music]amix=inputs=2:duration=shortest:dropout_transition=2[aout]`;

    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .input(backgroundMusicPath)
        .complexFilter(complexFilter)
        .outputOptions([
          '-c:v copy',
          '-c:a aac',
          '-map 0:v:0',
          '-map [aout]',
          '-shortest',
        ])
        .output(outputPath)
        .on('start', (cmd) => console.log(`[ffmpeg] ${cmd}`))
        .on('end', () => {
          console.log(`[ffmpeg] Muxed output (with music) saved: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (err: Error) =>
          reject(new Error(`FFmpeg mux failed: ${err.message}`)),
        )
        .run();
    });
  }

  // Original path: no background music
  const audioFilters: string[] = [];
  if (audioDuration > videoDuration && videoDuration > 0) {
    const ratio = audioDuration / videoDuration;
    audioFilters.push(atempoChain(ratio));
    console.log(
      `[ffmpeg] Narration overran video by ${((ratio - 1) * 100).toFixed(1)}%; time-scaling to fit`,
    );
  }

  return new Promise((resolve, reject) => {
    const command = ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v copy',
        '-c:a aac',
        '-map 0:v:0',
        '-map 1:a:0',
        '-shortest',
      ]);

    if (audioFilters.length > 0) {
      command.audioFilters(audioFilters);
    }

    command
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
