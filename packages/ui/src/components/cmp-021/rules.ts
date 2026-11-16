/** Image rules shared with the API (REQ-006): JPEG, PNG, WebP, GIF, at most 10 MiB. */
export const UPLOAD_ACCEPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_ACCEPT = UPLOAD_ACCEPT_TYPES.join(',');

export const UPLOAD_STATUSES = ['uploading', 'processing', 'ready', 'rejected'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/** Returns the reason a file cannot be uploaded, or null when it can. */
export function validateImageFile(file: { name: string; type: string; size: number }): string | null {
  if (!(UPLOAD_ACCEPT_TYPES as readonly string[]).includes(file.type)) {
    return 'Not supported. Use a JPEG, PNG, WebP or GIF image.';
  }
  if (file.size > UPLOAD_MAX_BYTES) return 'Too large. Images can be up to 10 MB.';
  if (file.size === 0) return 'This file is empty.';
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
