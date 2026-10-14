import { ImageIcon, TrashIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { ImageKind } from '@/config/images';
import { publicImageUrl } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { ImageValidationError, prepareImage } from '../media';

/**
 * Pick → validate → compress (WebP) → hand the File to `onUpload`. Used for logo, cover,
 * category and individual product images; replacing one image never touches others.
 */
export function ImagePicker({
  path,
  kind,
  label,
  onUpload,
  onRemove,
  className,
}: {
  path: string | null;
  kind: ImageKind;
  label: string;
  onUpload: (file: File) => Promise<void>;
  onRemove?: () => Promise<void>;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const url = publicImageUrl(path);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const prepared = await prepareImage(file, kind);
      await onUpload(prepared);
      toast.success('Изображение сохранено');
    } catch (e) {
      toast.error(e instanceof ImageValidationError ? e.message : e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
        {url ? <img src={url} alt={label} className="size-full object-cover" /> : <ImageIcon aria-hidden className="size-6 text-muted-foreground" />}
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          aria-label={`${label}: выбрать файл`}
          onChange={(e) => void handle(e.target.files?.[0])}
        />
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
          <UploadSimpleIcon aria-hidden /> {busy ? 'Загрузка…' : path ? 'Заменить' : 'Загрузить'}
        </Button>
        {path && onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onRemove();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Ошибка');
              } finally {
                setBusy(false);
              }
            }}
          >
            <TrashIcon aria-hidden /> Удалить
          </Button>
        )}
      </div>
    </div>
  );
}
