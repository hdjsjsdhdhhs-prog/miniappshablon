import imageCompression from 'browser-image-compression';
import { IMAGE_SETTINGS, type ImageKind } from '@/config/images';
import { supabase } from '@/lib/supabase';

export class ImageValidationError extends Error {}

/** Validates and compresses an image in the browser (WebP; JPEG for a broadcast photo) using the central settings. */
export async function prepareImage(file: File, kind: ImageKind): Promise<File> {
  const jpeg = kind === 'broadcast';
  if (!file.type.startsWith('image/')) throw new ImageValidationError('Выберите изображение (JPEG, PNG, WebP).');
  if (file.size > IMAGE_SETTINGS.maxSourceBytes) {
    throw new ImageValidationError(`Файл больше ${IMAGE_SETTINGS.maxSourceBytes / 1024 / 1024} МБ.`);
  }
  const opts = IMAGE_SETTINGS[kind];
  const compressed = await imageCompression(file, {
    maxSizeMB: opts.maxSizeMB,
    maxWidthOrHeight: opts.maxWidthOrHeight,
    initialQuality: opts.quality,
    fileType: jpeg ? 'image/jpeg' : 'image/webp',
    useWebWorker: true,
  });
  if (compressed.size > IMAGE_SETTINGS.maxUploadBytes) {
    throw new ImageValidationError('Не удалось сжать изображение до допустимого размера.');
  }
  return jpeg ? new File([compressed], 'image.jpg', { type: 'image/jpeg' }) : new File([compressed], 'image.webp', { type: 'image/webp' });
}

/**
 * Uploads the photo of a broadcast to "<shop_id>/broadcast/<uuid>.jpg" (the only shape broadcast_start accepts).
 * Storage policies enforce shop membership; the server reads the file itself when the broadcast is sent.
 */
export async function uploadBroadcastPhoto(shopId: string, file: File): Promise<string> {
  const path = `${shopId}/broadcast/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from(IMAGE_SETTINGS.bucket).upload(path, file, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
  if (error) throw new Error(`Не удалось загрузить фотографию: ${error.message}`);
  return path;
}

/** Removes a broadcast photo that was uploaded but not sent (best effort: an orphaned file harms nothing). */
export async function removeBroadcastPhoto(shopId: string, path: string | null | undefined): Promise<void> {
  if (!path || !path.startsWith(`${shopId}/broadcast/`)) return;
  await supabase.storage.from(IMAGE_SETTINGS.bucket).remove([path]);
}

/** Uploads to "<shop_id>/<entity>/<entity_id>/<uuid>.webp". Storage policies enforce shop membership. */
export async function uploadShopImage(shopId: string, entity: 'logo' | 'cover' | 'category' | 'product', entityId: string, file: File): Promise<string> {
  const path = `${shopId}/${entity}/${entityId}/${crypto.randomUUID()}.webp`;
  const { error } = await supabase.storage
    .from(IMAGE_SETTINGS.bucket)
    .upload(path, file, { contentType: file.type, cacheControl: '31536000', upsert: false });
  if (error) throw new Error(`Не удалось загрузить изображение: ${error.message}`);
  return path;
}

/**
 * Deletes a file only if no row references it anymore (shop logo/cover, categories,
 * product images). Seeded files may be shared between entities, so this check matters.
 */
export async function removeImageIfUnused(shopId: string, path: string | null | undefined): Promise<void> {
  if (!path || !path.startsWith(`${shopId}/`)) return;
  const [img, cat, shop] = await Promise.all([
    supabase.from('product_images').select('id', { count: 'exact', head: true }).eq('shop_id', shopId).eq('storage_path', path),
    supabase.from('categories').select('id', { count: 'exact', head: true }).eq('shop_id', shopId).eq('image_path', path),
    supabase.from('shops').select('id', { count: 'exact', head: true }).eq('id', shopId).or(`logo_path.eq.${path},cover_path.eq.${path}`),
  ]);
  if (img.error || cat.error || shop.error) return; // when unsure, keep the file
  if ((img.count ?? 0) + (cat.count ?? 0) + (shop.count ?? 0) > 0) return;
  await supabase.storage.from(IMAGE_SETTINGS.bucket).remove([path]);
}
