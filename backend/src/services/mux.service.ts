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
  musicVolume?: number; // 0–100, default 12
  outputDir: string;
  clipId: string;
}): Promise<string> {
  const { videoPath, audioPath, backgroundMusicPath, outputDir, clipId } = opts;
  // Convert 0–100 user-facing percentage to a 0.0–1.0 ffmpeg volume multiplier
  const musicVol = Math.max(0, Math.min(1, (opts.musicVolume ?? 12) / 100));
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
            .complexFilter(`[0:a:0]volume=1.0[v_audio];[1:a:0]volume=${musicVol.toFixed(4)}[music];[v_audio][music]amix=inputs=2:duration=first[aout]`)
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
      ? `[1:a]${atempoChain(audioDuration / videoDuration)}[narr];[2:a]volume=${musicVol.toFixed(4)}[music];[narr][music]amix=inputs=2:duration=shortest:dropout_transition=2[aout]`
      : `[1:a]anull[narr];[2:a]volume=${musicVol.toFixed(4)}[music];[narr][music]amix=inputs=2:duration=shortest:dropout_transition=2[aout]`;

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

  // Video streams share codec params (same generator), so they can be
  // stream-copied. Audio must be re-encoded: copying AAC packets across
  // concat boundaries carries each segment's encoder-priming samples along,
  // which truncates/garbles the audio at every joint (heard as clipped
  // words). aresample=async fills any residual timestamp gaps with silence
  // instead of dropping samples.
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions([
        '-c:v copy',
        '-c:a aac',
        '-b:a 192k',
        '-af aresample=async=1000',
      ])
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
 * Strip non-speech audio (music, laughter, ambience) from a video using
 * ffmpeg's RNNoise-based arnndn speech-isolation filter. The video stream is
 * copied untouched. Returns the original path unchanged if the model file is
 * missing or the video has no audio, so callers can use this best-effort.
 */
export async function isolateSpeech(opts: {
  videoPath: string;
  outputDir: string;
  clipId: string;
}): Promise<string> {
  const { videoPath, outputDir, clipId } = opts;
  const modelPath = process.env.RNNOISE_MODEL || './models/bd.rnnn';

  try {
    await fs.access(modelPath);
  } catch {
    console.warn(`[ffmpeg] RNNoise model not found at ${modelPath} — skipping speech isolation`);
    return videoPath;
  }
  if (!(await hasAudioStream(videoPath))) return videoPath;

  const outputPath = path.join(outputDir, `${clipId}_speech.mp4`);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      // Two RNNoise passes: one attenuates music/ambience, the second removes
      // the residue — measured noise floor drops to digital silence while
      // speech level stays within 0.5 dB of the original.
      .audioFilters([`highpass=f=100`, `arnndn=m=${modelPath}`, `arnndn=m=${modelPath}`])
      .outputOptions(['-c:v copy', '-c:a aac', '-b:a 192k'])
      .output(outputPath)
      .on('start', (c) => console.log(`[ffmpeg] ${c}`))
      .on('end', () => {
        console.log(`[ffmpeg] Speech isolation done: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err: Error) =>
        reject(new Error(`FFmpeg speech isolation failed: ${err.message}`)),
      )
      .run();
  });
}

/**
 * Join multiple video segments with a crossfade at each cut instead of a hard
 * cut. Video uses xfade, audio uses acrossfade (when every segment has audio).
 *
 * Each crossfade overlaps the segments by `fadeDuration`, so the joined video
 * is (n-1) * fadeDuration shorter than the sum of its parts. Video must be
 * re-encoded — xfade can't stream-copy.
 */
export async function crossfadeVideos(opts: {
  videoPaths: string[];
  outputDir: string;
  clipId: string;
  fadeDuration?: number;
}): Promise<string> {
  const { videoPaths, outputDir, clipId, fadeDuration = 0.5 } = opts;

  if (videoPaths.length === 1) return videoPaths[0];

  const [durations, audioFlags] = await Promise.all([
    Promise.all(videoPaths.map((p) => getMediaDuration(p))),
    Promise.all(videoPaths.map((p) => hasAudioStream(p))),
  ]);
  const allHaveAudio = audioFlags.every(Boolean);
  if (!allHaveAudio) {
    console.warn('[ffmpeg] Not all segments have audio — crossfading video only');
  }

  // Chain pairwise: [0][1]xfade[v1]; [v1][2]xfade[v2]; ... Each xfade offset
  // is where the fade starts on the accumulated output, which shrinks by one
  // fade length per joint.
  const filters: string[] = [];
  let accumulated = durations[0];
  for (let i = 1; i < videoPaths.length; i++) {
    const prevV = i === 1 ? '0:v' : `v${i - 1}`;
    const offset = Math.max(0, accumulated - fadeDuration);
    filters.push(
      `[${prevV}][${i}:v]xfade=transition=fade:duration=${fadeDuration}:offset=${offset.toFixed(3)}[v${i}]`,
    );
    accumulated = offset + durations[i];
  }
  if (allHaveAudio) {
    for (let i = 1; i < videoPaths.length; i++) {
      const prevA = i === 1 ? '0:a' : `a${i - 1}`;
      filters.push(`[${prevA}][${i}:a]acrossfade=d=${fadeDuration}[a${i}]`);
    }
  }

  const last = videoPaths.length - 1;
  const outputPath = path.join(outputDir, `${clipId}_joined.mp4`);

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    for (const p of videoPaths) cmd.input(p);

    cmd
      .complexFilter(filters)
      .outputOptions([
        `-map [v${last}]`,
        ...(allHaveAudio ? [`-map [a${last}]`] : []),
        '-c:v libx264',
        '-crf 18',
        '-preset medium',
        '-pix_fmt yuv420p',
        ...(allHaveAudio ? ['-c:a aac', '-b:a 192k'] : []),
      ])
      .output(outputPath)
      .on('start', (c) => console.log(`[ffmpeg] ${c}`))
      .on('end', () => {
        console.log(
          `[ffmpeg] Crossfaded ${videoPaths.length} segments (${fadeDuration}s fades) → ${outputPath}`,
        );
        resolve(outputPath);
      })
      .on('error', (err: Error) =>
        reject(new Error(`FFmpeg crossfade failed: ${err.message}`)),
      )
      .run();
  });
}

interface Region { w: number; h: number; x: number; y: number }

/**
 * Find the non-black content region of a video (Veo letterboxes presenter
 * footage with black bars) using ffmpeg cropdetect. Falls back to the full
 * frame if detection fails.
 */
function detectContentRegion(videoPath: string, fullW: number, fullH: number): Promise<Region> {
  return new Promise((resolve) => {
    let last: Region = { w: fullW, h: fullH, x: 0, y: 0 };
    ffmpeg()
      .input(videoPath)
      .inputOptions(['-ss 1', '-t 2'])
      .videoFilters('cropdetect=24:16:0')
      .format('null')
      .output('-')
      .on('stderr', (line: string) => {
        const m = line.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
        if (m) last = { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
      })
      .on('end', () => resolve(last))
      .on('error', () => resolve(last))
      .run();
  });
}

/**
 * Sample the actual green-screen color from a presenter video. Veo renders
 * the "green screen" as a muted green (nowhere near #00FF00), and it varies
 * per generation — keying on the sampled color at tight similarity is what
 * separates it from skin tones. Samples two patches near the top corners of
 * the content region (reliably background for a centered chest-up presenter)
 * and averages them.
 */
async function sampleBackgroundColor(
  videoPath: string,
  region: Region,
  outputDir: string,
  clipId: string,
): Promise<string> {
  const framePath = path.join(outputDir, `${clipId}_keyframe.png`);
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .inputOptions(['-ss 1'])
      .outputOptions(['-frames:v 1'])
      .output(framePath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });

  try {
    const sharp = (await import('sharp')).default;
    const patch = async (x: number, y: number) => {
      const buf = await sharp(framePath)
        .extract({ left: Math.round(x), top: Math.round(y), width: 16, height: 16 })
        .resize(1, 1)
        .removeAlpha()
        .raw()
        .toBuffer();
      return [buf[0], buf[1], buf[2]] as number[];
    };

    // The green varies with lighting, so sample along both edges at several
    // heights (edges are reliably background for a centered presenter) and key
    // on the MOST green-dominant sample — that's the true screen color.
    // Washed-out pale shades near the subject must never become key colors:
    // they sit too close to white clothing to key safely, and a colorkey that
    // matches the person is far worse than a faint background halo.
    const xs = [region.x + 8, region.x + region.w - 24];
    const ys = [0.15, 0.4, 0.65, 0.88].map((f) => region.y + region.h * f);
    const samples = await Promise.all(xs.flatMap((x) => ys.map((y) => patch(x, y))));

    const dominance = (s: number[]) => s[1] - Math.max(s[0], s[2]);
    const green = samples
      .filter((s) => dominance(s) > 20)
      .sort((a, b) => dominance(b) - dominance(a))[0];
    if (!green) return '0x00FF00';
    return `0x${green.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  } finally {
    await fs.unlink(framePath).catch(() => {});
  }
}

/**
 * Superimpose a green-screen presenter video onto a background video.
 * The presenter's letterbox bars are cropped away, the actual background
 * color is sampled from the footage and keyed out (colorkey at tight
 * similarity — Veo's muted green sits too close to skin tones in chroma
 * space for a fixed #00FF00 chromakey), and the background video is
 * scaled/cropped to cover the presenter's full frame. The result runs for
 * the presenter's duration (background loops if shorter). The audio mixes
 * both sources: the presenter's voice at full level with the background
 * video's track ducked underneath, so both stay audible.
 */
export async function chromaKeyComposite(opts: {
  presenterPath: string;
  backgroundPath: string;
  outputDir: string;
  clipId: string;
  presenterScale?: number; // 0-1 fraction of frame height (default 0.4)
}): Promise<string> {
  const { presenterPath, backgroundPath, outputDir, clipId, presenterScale = 0.4 } = opts;
  const outputPath = path.join(outputDir, `${clipId}_composite.mp4`);

  const probe = (file: string) =>
    new Promise<{ w: number; h: number; dur: number; hasAudio: boolean }>((resolve, reject) => {
      ffmpeg.ffprobe(file, (err, md) => {
        if (err) {
          reject(new Error(`ffprobe failed for ${file}: ${err.message}`));
          return;
        }
        const vs = (md.streams ?? []).find((s) => s.codec_type === 'video');
        resolve({
          w: vs?.width ?? 720,
          h: vs?.height ?? 1280,
          dur: md.format?.duration ?? 0,
          hasAudio: (md.streams ?? []).some((s) => s.codec_type === 'audio'),
        });
      });
    });

  const meta = await probe(presenterPath);
  const bgHasAudio = await probe(backgroundPath)
    .then((m) => m.hasAudio)
    .catch(() => false);

  const region = await detectContentRegion(presenterPath, meta.w, meta.h);
  const keyColor = await sampleBackgroundColor(presenterPath, region, outputDir, clipId).catch(
    (err) => {
      console.warn(`[ffmpeg] Key color sampling failed (${(err as Error).message}); using 0x00FF00`);
      return '0x00FF00';
    },
  );
  console.log(
    `[ffmpeg] Compositing: content ${region.w}x${region.h}@${region.x},${region.y}, key color ${keyColor}, ` +
      `scaled to ${Math.round(presenterScale * 100)}% frame height, overlay at lower-left`,
  );

  // Scale the presenter to the requested fraction of the frame height
  // (preserving aspect ratio) and anchor it in the lower-left corner.
  const targetH = Math.round(meta.h * presenterScale);
  const targetW = Math.round((region.w / region.h) * targetH);
  const margin = Math.round(Math.min(meta.w, meta.h) * 0.02);
  const overlayX = margin;
  const overlayY = meta.h - targetH - margin;

  const filters = [
    `[0:v]scale=${meta.w}:${meta.h}:force_original_aspect_ratio=increase,crop=${meta.w}:${meta.h}[bg]`,
    `[1:v]crop=${region.w}:${region.h}:${region.x}:${region.y},format=rgba,` +
      `colorkey=${keyColor}:0.11:0.05,despill=type=green,` +
      `scale=${targetW}:${targetH}[fg]`,
    `[bg][fg]overlay=${overlayX}:${overlayY}[vout]`,
  ];

  // Mix both audio tracks when available: presenter voice at full level with
  // the background's narration/music ducked underneath, limited to avoid
  // clipping. The presenter track leads amix, so `duration=first` follows the
  // presenter (the looped background is infinite). Fall back to whichever
  // single track exists.
  const audioOptions: string[] = [];
  if (meta.hasAudio && bgHasAudio) {
    filters.push(
      '[0:a]volume=0.5[bga]',
      '[1:a][bga]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]',
    );
    audioOptions.push('-map [aout]', '-c:a aac', '-b:a 192k');
  } else if (meta.hasAudio) {
    audioOptions.push('-map 1:a:0', '-c:a aac', '-b:a 192k');
  } else if (bgHasAudio) {
    audioOptions.push('-map 0:a:0', '-c:a aac', '-b:a 192k');
  }
  console.log(
    `[ffmpeg] Composite audio: presenter=${meta.hasAudio}, background=${bgHasAudio}` +
      `${meta.hasAudio && bgHasAudio ? ' — mixing (background at 50%)' : ''}`,
  );

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(backgroundPath)
      .inputOptions(['-stream_loop -1']) // loop background if shorter than presenter
      .input(presenterPath)
      .complexFilter(filters)
      .outputOptions([
        '-map [vout]',
        ...audioOptions,
        `-t ${meta.dur}`,
        '-c:v libx264',
        '-crf 18',
        '-preset medium',
        '-pix_fmt yuv420p',
      ])
      .output(outputPath)
      .on('start', (c) => console.log(`[ffmpeg] ${c}`))
      .on('end', () => {
        console.log(`[ffmpeg] Chroma-key composite saved: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err: Error) =>
        reject(new Error(`FFmpeg composite failed: ${err.message}`)),
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
