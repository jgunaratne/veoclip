import { GoogleAuth } from 'google-auth-library';
import fs from 'fs/promises';
import path from 'path';

// ---------------------------------------------------------------------------
// Auth strategy selection
// ---------------------------------------------------------------------------

type AuthMode = 'vertex' | 'gemini';

function getAuthMode(): AuthMode {
  if (process.env.GCP_PROJECT_ID) return 'vertex';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  throw new Error(
    'No API credentials configured. Set GCP_PROJECT_ID (for Vertex AI) ' +
      'or GEMINI_API_KEY (for Gemini API).',
  );
}

// Lazy-init GoogleAuth — only created when using Vertex AI
let _auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!_auth) {
    _auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }
  return _auth;
}

async function getAccessToken(): Promise<string> {
  const client = await getAuth().getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) {
    throw new Error('Failed to obtain access token for Vertex AI');
  }
  return tokenResponse.token;
}

// ---------------------------------------------------------------------------
// Vertex AI implementation
// ---------------------------------------------------------------------------

async function generateVideoVertex(opts: {
  imageBase64: string;
  mimeType: string;
  prompt: string;
  duration: number;
  outputDir: string;
  clipId: string;
  onStatusChange: (status: string) => void;
}): Promise<string> {
  const { imageBase64, mimeType, prompt, duration, outputDir, clipId, onStatusChange } = opts;

  const projectId = process.env.GCP_PROJECT_ID!;
  const location = process.env.GCP_LOCATION || 'us-central1';
  const model = process.env.VEO_MODEL || 'veo-2.0-generate-001';

  const accessToken = await getAccessToken();

  // 1. Submit generation request
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predictLongRunning`;

  const body = {
    instances: [
      {
        prompt,
        image: {
          bytesBase64Encoded: imageBase64,
          mimeType,
        },
      },
    ],
    parameters: {
      aspectRatio: '16:9',
      personGeneration: 'allow_all',
      durationSeconds: duration,
      sampleCount: 1,
      enhancePrompt: true,
    },
  };

  onStatusChange('generating_video');

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

    /* eslint-disable @typescript-eslint/no-explicit-any */
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
        throw new Error(`Video filtered: ${reason}`);
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
  imageBase64: string;
  mimeType: string;
  prompt: string;
  duration: number;
  outputDir: string;
  clipId: string;
  onStatusChange: (status: string) => void;
}): Promise<string> {
  const { imageBase64, mimeType, prompt, duration, outputDir, clipId, onStatusChange } = opts;

  const apiKey = process.env.GEMINI_API_KEY!;
  const model = process.env.VEO_MODEL || 'veo-2.0-generate-001';
  const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  // 1. Submit generation request
  const url = `${baseUrl}/models/${model}:generateVideo?key=${apiKey}`;

  const body = {
    prompt: {
      text: prompt,
    },
    image: {
      imageBytes: imageBase64,
      mimeType,
    },
    generationConfig: {
      durationSeconds: duration,
      aspectRatio: '16:9',
      personGeneration: 'allow_all',
      numberOfVideos: 1,
      enhancePrompt: true,
    },
  };

  onStatusChange('generating_video');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

    const pollUrl = `${baseUrl}/${operationName}?key=${apiKey}`;
    const pollResponse = await fetch(pollUrl, { method: 'GET' });

    if (!pollResponse.ok) {
      console.error(`[veo/gemini] Poll error: ${pollResponse.status}`);
      continue;
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
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
        throw new Error(`Video filtered: ${reason}`);
      }

      // Extract video bytes — Gemini API returns inline base64
      let videoBytes: string | null = null;

      if (resp?.generatedSamples?.[0]?.video?.videoBytes) {
        videoBytes = resp.generatedSamples[0].video.videoBytes;
      } else if (resp?.generatedSamples?.[0]?.video?.bytesBase64Encoded) {
        videoBytes = resp.generatedSamples[0].video.bytesBase64Encoded;
      } else if (resp?.videos?.[0]?.videoBytes) {
        videoBytes = resp.videos[0].videoBytes;
      } else if (resp?.videos?.[0]?.bytesBase64Encoded) {
        videoBytes = resp.videos[0].bytesBase64Encoded;
      } else if (resp?.predictions?.[0]?.bytesBase64Encoded) {
        videoBytes = resp.predictions[0].bytesBase64Encoded;
      }

      if (!videoBytes) {
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

      const videoFileName = `${clipId}_raw.mp4`;
      const videoPath = path.join(outputDir, videoFileName);
      await fs.writeFile(videoPath, Buffer.from(videoBytes, 'base64'));

      console.log(`[veo/gemini] Video saved: ${videoPath}`);
      return videoPath;
    }

    console.log(`[veo/gemini] Poll ${i + 1}/${maxPolls} — still running…`);
  }

  throw new Error('Veo generation timed out after 10 minutes');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a video using Veo.
 *
 * Automatically selects the auth strategy based on environment variables:
 *   - GCP_PROJECT_ID  → Vertex AI  (uses Application Default Credentials)
 *   - GEMINI_API_KEY  → Gemini API (uses the API key directly)
 *
 * GCP_PROJECT_ID takes precedence when both are set.
 */
export async function generateVideo(opts: {
  imagePath: string;
  prompt: string;
  duration: number;
  outputDir: string;
  clipId: string;
  onStatusChange: (status: string) => void;
}): Promise<string> {
  const { imagePath, prompt, duration, outputDir, clipId, onStatusChange } = opts;

  // Shared: read image once regardless of auth mode
  const imageBuffer = await fs.readFile(imagePath);
  const imageBase64 = imageBuffer.toString('base64');
  const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const mode = getAuthMode();
  console.log(`[veo] Using auth mode: ${mode}`);

  const sharedOpts = { imageBase64, mimeType, prompt, duration, outputDir, clipId, onStatusChange };

  if (mode === 'vertex') {
    return generateVideoVertex(sharedOpts);
  } else {
    return generateVideoGemini(sharedOpts);
  }
}
