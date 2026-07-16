import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { getGenerateContentEndpoint } from './google-auth.js';

function mimeTypeFor(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

const GREEN_SCREEN_EDIT_PROMPT =
  'Replace the entire background of this image with a solid, uniform, bright green ' +
  'chroma key screen (#00FF00). Keep the subject in the foreground completely ' +
  'unchanged — same pose, same appearance, same clothing, same lighting on the ' +
  'subject, same framing and crop. The result must look like the subject was ' +
  'photographed in front of a flat green screen: every background pixel the exact ' +
  'same flat green, with no gradients, shadows, objects, or scenery.';

/**
 * Replace an image's background with a solid green chroma key screen using the
 * Gemini image model. Veo image-to-video strongly preserves the seed image's
 * background, so green-screening the seed is what actually guarantees a green
 * background in the generated segment — prompts alone can't override it.
 *
 * Best-effort: returns the original path if editing fails. The result is
 * cached next to the source file, so repeated pipeline runs reuse it.
 */
export async function ensureGreenScreenBackground(imagePath: string): Promise<string> {
  const outPath = greenScreenDerivativePath(imagePath);

  // Reuse a previous run's output
  try {
    await fs.access(outPath);
    console.log(`[image] Reusing cached green-screen image: ${path.basename(outPath)}`);
    return outPath;
  } catch {
    // not cached yet
  }

  try {
    const buffer = await fs.readFile(imagePath);
    const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
    const { url, headers } = await getGenerateContentEndpoint(model);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: mimeTypeFor(imagePath),
                  data: buffer.toString('base64'),
                },
              },
              { text: GREEN_SCREEN_EDIT_PROMPT },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${response.status} ${errorText.slice(0, 200)}`);
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const json = (await response.json()) as Record<string, any>;
    const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p) => p?.inlineData?.data);
    if (!imagePart) {
      const finishReason = json?.candidates?.[0]?.finishReason;
      throw new Error(`no image in response (finishReason=${finishReason})`);
    }

    // Normalize to PNG so downstream mime detection (by extension) is correct
    const edited = Buffer.from(imagePart.inlineData.data as string, 'base64');
    await sharp(edited).png().toFile(outPath);

    console.log(
      `[image] Green-screened background: ${path.basename(imagePath)} → ${path.basename(outPath)}`,
    );
    return outPath;
  } catch (err) {
    console.warn(
      `[image] Green-screen preprocessing failed for ${path.basename(imagePath)} ` +
        `(using original image): ${(err as Error).message}`,
    );
    return imagePath;
  }
}

/** Path where ensureGreenScreenBackground caches its output for a source image. */
export function greenScreenDerivativePath(imagePath: string): string {
  return imagePath.replace(/\.[^.]+$/, '') + '_greenscreen.png';
}
