/** Bounds decoded image data before it can enter a model request. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_ENCODED_IMAGE_BYTES = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

/** Accepts actual image bytes, independently of the transport's declared format. */
export function imageDataUrl(data: string): string {
  if (!data || data.length > MAX_ENCODED_IMAGE_BYTES || data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error('Image must contain valid base64 data no larger than 5 MiB.');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== data) {
    throw new Error('Image contains invalid or oversized base64 data.');
  }
  let mimeType: string;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mimeType = 'image/png';
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mimeType = 'image/jpeg';
  } else if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) {
    mimeType = 'image/gif';
  } else if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    mimeType = 'image/webp';
  } else {
    throw new Error('Only PNG, JPEG, GIF, and WebP image inputs are supported.');
  }
  return `data:${mimeType};base64,${data}`;
}
