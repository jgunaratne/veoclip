import { GoogleAuth } from 'google-auth-library';

// ---------------------------------------------------------------------------
// Shared Google auth strategy selection
// ---------------------------------------------------------------------------

export type AuthMode = 'vertex' | 'gemini';

/**
 * Pick the auth strategy from environment variables:
 *   - GEMINI_API_KEY  → Gemini API (uses the API key directly)
 *   - GCP_PROJECT_ID  → Vertex AI  (uses Application Default Credentials)
 *
 * GEMINI_API_KEY takes precedence when both are set — the Gemini API is
 * where the latest models (veo-3.1, gemini-3.5) are available.
 */
export function getAuthMode(): AuthMode {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.GCP_PROJECT_ID) return 'vertex';
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

export async function getAccessToken(): Promise<string> {
  const client = await getAuth().getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) {
    throw new Error('Failed to obtain access token for Vertex AI');
  }
  return tokenResponse.token;
}

/** Base URL + headers for a Gemini generateContent call in either auth mode. */
export async function getGenerateContentEndpoint(
  model: string,
): Promise<{ url: string; headers: Record<string, string> }> {
  const mode = getAuthMode();

  if (mode === 'vertex') {
    const projectId = process.env.GCP_PROJECT_ID!;
    const location = process.env.GCP_LOCATION || 'us-central1';
    return {
      url: `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`,
      headers: {
        Authorization: `Bearer ${await getAccessToken()}`,
        'Content-Type': 'application/json',
      },
    };
  }

  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: {
      'x-goog-api-key': process.env.GEMINI_API_KEY!,
      'Content-Type': 'application/json',
    },
  };
}
