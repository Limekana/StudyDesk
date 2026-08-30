// v1.12 Item 9 — client-side image normalisation.
//
// **This is a privacy control, not an optimisation.** A phone photo carries an
// EXIF block, and on most phones that block contains GPS coordinates. A student
// uploading a selfie taken at home would otherwise ship their home address to
// the server inside the file. Re-encoding through a canvas is what removes it:
// `drawImage` copies PIXELS only, and `toBlob` writes a brand-new file with no
// metadata section at all. The stripping is structural — there is no metadata
// to forget to remove, because none is ever carried across.
//
// The size cap is the secondary benefit: enforcing 256x256 WebP before the
// request leaves the device means the 256 KB bucket ceiling is never the thing
// the user discovers, and it bounds egress, which the plan flags as the tighter
// constraint of the two.

/** Square edge, in pixels. 256 is comfortably past what any avatar slot in the
 *  app renders, including a 2x desktop display. */
export const AVATAR_EDGE = 256;

/** Hard ceiling, matching the bucket's `file_size_limit`. */
export const AVATAR_MAX_BYTES = 262144;

/** What the bucket's `allowed_mime_types` accepts. SVG is excluded on purpose
 *  — it can carry <script> and is stored-XSS in a WebView. */
export const ACCEPTED_INPUT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Decode a user-selected file into an ImageBitmap, or an <img> where
 * createImageBitmap is unavailable.
 *
 * Note this decodes the file the browser was given rather than trusting its
 * declared type: a file renamed to .png that is not an image fails here, before
 * anything is uploaded.
 */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through — some engines refuse certain colour profiles here but
      // still decode the same bytes via an <img>.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('decode-failed'));
      el.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Re-encode an image file to a square WebP with no metadata.
 *
 * Centre-crops to a square first so faces are not squashed by a non-square
 * source, which is the common case for a phone photo.
 *
 * @returns {Promise<Blob>} a WebP blob, guaranteed EXIF-free by construction.
 * @throws {Error} with `.code` of 'bad-type' | 'decode-failed' | 'too-large'
 */
export async function encodeAvatar(file) {
  if (!file || !ACCEPTED_INPUT_TYPES.includes(file.type)) {
    const e = new Error('bad-type');
    e.code = 'bad-type';
    throw e;
  }

  const src = await decode(file);
  const sw = src.width;
  const sh = src.height;
  if (!sw || !sh) {
    const e = new Error('decode-failed');
    e.code = 'decode-failed';
    throw e;
  }

  // Centre crop to a square.
  const edge = Math.min(sw, sh);
  const sx = Math.floor((sw - edge) / 2);
  const sy = Math.floor((sh - edge) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_EDGE;
  canvas.height = AVATAR_EDGE;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    const e = new Error('decode-failed');
    e.code = 'decode-failed';
    throw e;
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, edge, edge, 0, 0, AVATAR_EDGE, AVATAR_EDGE);
  if (typeof src.close === 'function') src.close();

  // Step the quality down until it fits. Starting at 0.9 and stopping at 0.5
  // because below that a 256px avatar visibly falls apart, and a 256x256 WebP
  // that still exceeds 256 KB at 0.5 is not a photograph.
  for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
    if (!blob) break;
    if (blob.size <= AVATAR_MAX_BYTES) return blob;
  }

  const e = new Error('too-large');
  e.code = 'too-large';
  throw e;
}
