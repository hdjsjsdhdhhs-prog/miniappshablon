import { ImageIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { publicImageUrl } from '@/lib/supabase';
import { cn } from '@/lib/utils';

/** Fixed-ratio image with lazy loading and a neutral placeholder for missing/broken files. */
export function ProductImage({
  path,
  alt,
  className,
  eager = false,
  sizes = '(min-width: 1024px) 25vw, 50vw',
}: {
  path: string | null | undefined;
  alt: string;
  className?: string;
  eager?: boolean;
  sizes?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = publicImageUrl(path);
  return (
    <div className={cn('relative aspect-square overflow-hidden bg-muted', className)}>
      {url && !failed ? (
        <img
          src={url}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          sizes={sizes}
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        <div className="flex size-full items-center justify-center text-muted-foreground" aria-label={`${alt}: нет фото`} role="img">
          <ImageIcon aria-hidden className="size-1/4 opacity-60" />
        </div>
      )}
    </div>
  );
}
