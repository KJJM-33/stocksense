/**
 * Shared helper for the Claude vision routes (/api/scan, /api/receipt):
 * splits a base64 image data URL into the payload + media type the
 * Anthropic SDK expects.
 */

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export function extractBase64(dataUrl: string): { data: string; mediaType: ImageMediaType } {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URL');
  const mimeType = match[1];
  const validTypes: ImageMediaType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!validTypes.includes(mimeType as ImageMediaType)) {
    throw new Error(`Unsupported image type: ${mimeType}. Use JPEG, PNG, GIF, or WebP.`);
  }
  return { data: match[2], mediaType: mimeType as ImageMediaType };
}
