import fs from 'fs/promises';
import path from 'path';
import { getAuthMode, getAccessToken } from './google-auth.js';

// Vertical 9:16 — the clips are made for phone/social-media playback.
const ASPECT_RATIO = '9:16';

/** Thrown when Veo's safety filter rejects the generated video, so the
 *  pipeline can retry the segment with a sanitized prompt. */
export class VideoFilteredError extends Error {
  constructor(reason: string) {
    super(`Video filtered: ${reason}`);
    this.name = 'VideoFilteredError';
  }
}

// ---------------------------------------------------------------------------
// Vertex AI implementation
// ---------------------------------------------------------------------------

async function generateVideoVertex(opts: {
  imageBase64: string | null;
  mimeType: string;
  prompt: string;
  negativePrompt?: string;
  duration: number;
  outputDir: string;
  clipId: string;
}): Promise<string> {
  const { imageBase64, mimeType, prompt, negativePrompt, duration, outputDir, clipId } = opts;

  const projectId = process.env.GCP_PROJECT_ID!;
  const location = process.env.GCP_LOCATION || 'us-central1';
  const model = process.env.VEO_MODEL || 'veo-2.0-generate-001';

  const accessToken = await getAccessToken();

  // 1. Submit generation request
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predictLongRunning`;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const instance: Record<string, any> = { prompt };
  if (imageBase64) {
    instance.image = {
      bytesBase64Encoded: imageBase64,
      mimeType,
    };
  }

  const body = {
    instances: [instance],
    parameters: {
      aspectRatio: ASPECT_RATIO,
      personGeneration: 'allow_all',
      durationSeconds: duration,
      sampleCount: 1,
      enhancePrompt: true,
      ...(negativePrompt ? { negativePrompt } : {}),
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Veo API error: ${response.status} ${errorText}`);
  }

  const operation = (await response.json()) as { name: string };
  const operationName = operation.name;
  console.log(`[veo/vertex] Operation started: ${operationName}`);

  // 2. Poll for completion (40 × 15 s = 10 min max)
  const maxPolls = 40;
  const pollIntervalMs = 15_000;

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const freshToken = await getAccessToken();

    const pollUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:fetchPredictOperation`;
    const pollResponse = await fetch(pollUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${freshToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operationName }),
    });

    if (!pollResponse.ok) {
      console.error(`[veo/vertex] Poll error: ${pollResponse.status}`);
      continue;
    }

    const pollResult = (await pollResponse.json()) as Record<string, any>;

    if (pollResult.done) {
      if (pollResult.error) {
        throw new Error(
          `Veo generation failed: ${JSON.stringify(pollResult.error)}`,
        );
      }

      const resp = pollResult.response ?? {};

      // Check for RAI content filtering
      if (resp.raiMediaFilteredCount > 0) {
        const reason =
          resp.raiMediaFilteredReasons?.[0] ??
          'Content filtered by safety guidelines';
        throw new VideoFilteredError(reason);
      }

      // Extract video — try every path Vertex supports
      let videoUrl: string | null = null;
      let videoBytes: string | null = null;

      if (resp?.generatedSamples?.[0]?.video?.uri) {
        videoUrl = resp.generatedSamples[0].video.uri;
      } else if (resp?.videos?.[0]?.uri) {
        videoUrl = resp.videos[0].uri;
      } else if (resp?.videos?.[0]?.gcsUri) {
        videoUrl = resp.videos[0].gcsUri;
      } else if (resp?.generatedSamples?.[0]?.video?.videoBytes) {
        videoBytes = resp.generatedSamples[0].video.videoBytes;
      } else if (
        resp?.videos?.[0]?.videoBytes ||
        resp?.videos?.[0]?.bytesBase64Encoded
      ) {
        videoBytes =
          resp.videos[0].videoBytes || resp.videos[0].bytesBase64Encoded;
      } else if (resp?.predictions?.[0]?.bytesBase64Encoded) {
        videoBytes = resp.predictions[0].bytesBase64Encoded;
      }

      // If we got a GCS URL, fetch the bytes
      if (videoUrl && !videoBytes) {
        console.log(`[veo/vertex] Fetching video from: ${videoUrl}`);
        const freshToken2 = await getAccessToken();
        const videoResponse = await fetch(videoUrl, {
          headers: { Authorization: `Bearer ${freshToken2}` },
        });
        if (!videoResponse.ok) {
          throw new Error(
            `Failed to fetch video from GCS: ${videoResponse.status}`,
          );
        }
        const buffer = await videoResponse.arrayBuffer();
        videoBytes = Buffer.from(buffer).toString('base64');
      }

      if (!videoBytes) {
        console.error(
          '[veo/vertex] Unexpected response structure:',
          JSON.stringify(
            resp,
            (key, val) =>
              typeof val === 'string' && val.length > 200
                ? `[string ${val.length} chars]`
                : val,
            2,
          ),
        );
        throw new Error('No video data in Veo response');
      }

      const videoFileName = `${clipId}_raw.mp4`;
      const videoPath = path.join(outputDir, videoFileName);
      await fs.writeFile(videoPath, Buffer.from(videoBytes, 'base64'));

      console.log(`[veo/vertex] Video saved: ${videoPath}`);
      return videoPath;
    }

    console.log(`[veo/vertex] Poll ${i + 1}/${maxPolls} — still running…`);
  }

  throw new Error('Veo generation timed out after 10 minutes');
}

// ---------------------------------------------------------------------------
// Gemini API implementation
// ---------------------------------------------------------------------------

async function generateVideoGemini(opts: {
  imageBase64: string | null;
  mimeType: string;
  prompt: string;
  negativePrompt?: string;
  duration: number;
  outputDir: string;
  clipId: string;
}): Promise<string> {
  const { imageBase64, mimeType, prompt, negativePrompt, duration, outputDir, clipId } = opts;

  const apiKey = process.env.GEMINI_API_KEY!;
  const model = process.env.VEO_MODEL || 'veo-3.1-fast-generate-preview';
  const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  // 1. Submit generation request — Gemini Veo uses instances/parameters,
  //    and the seed image rides along as inline bytes on the instance.
  const url = `${baseUrl}/models/${model}:predictLongRunning`;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const instance: Record<string, any> = { prompt };
  if (imageBase64) {
    instance.image = {
      bytesBase64Encoded: imageBase64,
      mimeType,
    };
  }

  const body = {
    instances: [instance],
    parameters: {
      durationSeconds: duration,
      aspectRatio: ASPECT_RATIO,
      personGeneration: 'allow_all',
      ...(negativePrompt ? { negativePrompt } : {}),
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini Veo API error: ${response.status} ${errorText}`);
  }

  const operation = (await response.json()) as { name: string };
  const operationName = operation.name;
  console.log(`[veo/gemini] Operation started: ${operationName}`);

  // 2. Poll for completion (40 × 15 s = 10 min max)
  //    Gemini long-running operations are polled via GET on the operation resource.
  const maxPolls = 40;
  const pollIntervalMs = 15_000;

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const pollUrl = `${baseUrl}/${operationName}`;
    const pollResponse = await fetch(pollUrl, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
    });

    if (!pollResponse.ok) {
      console.error(`[veo/gemini] Poll error: ${pollResponse.status}`);
      continue;
    }

    const pollResult = (await pollResponse.json()) as Record<string, any>;

    if (!pollResult.done) {
      console.log(`[veo/gemini] Poll ${i + 1}/${maxPolls} — still running…`);
      continue;
    }

    if (pollResult.error) {
      throw new Error(
        `Veo generation failed: ${JSON.stringify(pollResult.error)}`,
      );
    }

    // Veo nests its payload one level down, under generateVideoResponse.
    const outer = pollResult.response ?? {};
    const resp = outer.generateVideoResponse ?? outer;

    // Check for RAI content filtering
    if (resp.raiMediaFilteredCount > 0) {
      const reason =
        resp.raiMediaFilteredReasons?.[0] ??
        'Content filtered by safety guidelines';
      throw new VideoFilteredError(reason);
    }

    const video = resp?.generatedSamples?.[0]?.video ?? resp?.videos?.[0];
    if (!video) {
      console.error(
        '[veo/gemini] Unexpected response structure:',
        JSON.stringify(
          resp,
          (key, val) =>
            typeof val === 'string' && val.length > 200
              ? `[string ${val.length} chars]`
              : val,
          2,
        ),
      );
      throw new Error('No video data in Veo response');
    }

    let videoBuffer: Buffer;

    if (video.uri) {
      // The API hands back a URI to fetch, not the bytes themselves.
      // The URI is not pre-signed; it needs the API key like any other call.
      console.log(`[veo/gemini] Downloading video from: ${video.uri}`);
      const videoResponse = await fetch(video.uri, {
        headers: { 'x-goog-api-key': apiKey },
      });
      if (!videoResponse.ok) {
        throw new Error(
          `Failed to download video: ${videoResponse.status}`,
        );
      }
      videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
    } else {
      // Some responses inline the bytes instead; accept either.
      const videoBytes = video.videoBytes || video.bytesBase64Encoded;
      if (!videoBytes) {
        throw new Error('No video data in Veo response');
      }
      videoBuffer = Buffer.from(videoBytes, 'base64');
    }

    const videoFileName = `${clipId}_raw.mp4`;
    const videoPath = path.join(outputDir, videoFileName);
    await fs.writeFile(videoPath, videoBuffer);

    console.log(`[veo/gemini] Video saved: ${videoPath} (${videoBuffer.length} bytes)`);
    return videoPath;
  }

  throw new Error('Veo generation timed out after 10 minutes');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a video segment using Veo. The seed image is optional — segments
 * without one are generated from the prompt alone.
 *
 * Automatically selects the auth strategy based on environment variables:
 *   - GEMINI_API_KEY  → Gemini API (uses the API key directly; latest models)
 *   - GCP_PROJECT_ID  → Vertex AI  (uses Application Default Credentials)
 *
 * GEMINI_API_KEY takes precedence when both are set.
 */
export async function generateVideo(opts: {
  imagePath: string | null;
  prompt: string;
  negativePrompt?: string;
  duration: number;
  outputDir: string;
  clipId: string;
}): Promise<string> {
  const { imagePath, prompt, negativePrompt, duration, outputDir, clipId } = opts;

  let imageBase64: string | null = null;
  let mimeType = 'image/jpeg';
  if (imagePath) {
    const imageBuffer = await fs.readFile(imagePath);
    imageBase64 = imageBuffer.toString('base64');
    if (imagePath.endsWith('.png')) mimeType = 'image/png';
    else if (imagePath.endsWith('.webp')) mimeType = 'image/webp';
  }

  const mode = getAuthMode();
  console.log(`[veo] Using auth mode: ${mode}`);

  const sharedOpts = { imageBase64, mimeType, prompt, negativePrompt, duration, outputDir, clipId };

  const MAX_RETRIES = 3;
  const BACKOFF_SECONDS = [10, 20, 40];

  for (let attempt = 0; ; attempt++) {
    try {
      if (mode === 'vertex') {
        return await generateVideoVertex(sharedOpts);
      } else {
        return await generateVideoGemini(sharedOpts);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errObj = err as { code?: number };
      const isHighDemand =
        message.toLowerCase().includes('high demand') || errObj.code === 14;

      if (isHighDemand && attempt < MAX_RETRIES) {
        const waitSec = BACKOFF_SECONDS[attempt];
        console.warn(
          `[veo] High demand error (attempt ${attempt + 1}/${MAX_RETRIES + 1}), ` +
            `retrying in ${waitSec}s: ${message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
        continue;
      }

      throw err;
    }
  }
}
