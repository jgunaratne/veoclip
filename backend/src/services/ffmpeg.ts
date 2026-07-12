import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

// Use the bundled static binaries so no system ffmpeg install is needed.
// A system install (if present on PATH) still wins via env overrides.
if (!process.env.FFMPEG_PATH && ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic as unknown as string);
}
if (!process.env.FFPROBE_PATH && ffprobeStatic?.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

export default ffmpeg;
