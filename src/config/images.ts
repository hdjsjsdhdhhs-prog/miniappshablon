/**
 * Central image settings. Used by the admin uploader (browser-image-compression) and by the
 * tenant pipeline validation. Keep in sync with the Storage bucket limit (5 MiB) in migrations.
 */
export const IMAGE_SETTINGS = {
  bucket: 'shop-media',
  /** Hard limit enforced by the Storage bucket. */
  maxUploadBytes: 5 * 1024 * 1024,
  /** Raw file the user may pick before compression. */
  maxSourceBytes: 25 * 1024 * 1024,
  allowedMimeTypes: ['image/webp', 'image/jpeg', 'image/png'] as const,
  product: { maxWidthOrHeight: 1600, maxSizeMB: 0.6, quality: 0.82 },
  cover: { maxWidthOrHeight: 1920, maxSizeMB: 0.8, quality: 0.82 },
  logo: { maxWidthOrHeight: 512, maxSizeMB: 0.2, quality: 0.9 },
  category: { maxWidthOrHeight: 800, maxSizeMB: 0.3, quality: 0.82 },
  /** Minimal source dimension accepted by tenant:validate. */
  minDimension: 128,
} as const;

export type ImageKind = 'product' | 'cover' | 'logo' | 'category';
