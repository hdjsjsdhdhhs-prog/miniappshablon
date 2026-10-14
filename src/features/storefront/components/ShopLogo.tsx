import { publicImageUrl } from '@/lib/supabase';
import { cn } from '@/lib/utils';

export function ShopLogo({ name, path, className }: { name: string; path: string | null; className?: string }) {
  const url = publicImageUrl(path);
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return url ? (
    <img src={url} alt={`Логотип ${name}`} className={cn('size-12 rounded-xl object-cover', className)} />
  ) : (
    <span
      aria-hidden
      className={cn(
        'flex size-12 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground',
        className,
      )}
    >
      {initials}
    </span>
  );
}
