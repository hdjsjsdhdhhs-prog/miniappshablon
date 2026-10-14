import { ArrowClockwiseIcon, WarningCircleIcon, WifiSlashIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function ErrorState({
  title = 'Не удалось загрузить данные',
  description = 'Проверьте подключение и попробуйте ещё раз.',
  onRetry,
  className,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={cn('flex flex-col items-center gap-3 px-6 py-12 text-center', className)}>
      <WarningCircleIcon aria-hidden className="size-10 text-destructive" />
      <div className="space-y-1">
        <p className="font-semibold">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          <ArrowClockwiseIcon aria-hidden /> Повторить
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-12 text-center', className)}>
      {icon && <div className="text-muted-foreground [&_svg]:size-10">{icon}</div>}
      <div className="space-y-1">
        <p className="font-semibold">{title}</p>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Shown when cached data is displayed after a failed refetch: prices/stock may be outdated. */
export function StaleDataNotice({ onRetry }: { onRetry?: () => void }) {
  return (
    <div
      role="status"
      className="mx-4 my-2 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
    >
      <WifiSlashIcon aria-hidden className="size-4 shrink-0" />
      <span className="flex-1">Нет связи. Цены и наличие могут быть неактуальны — магазин проверит их при оформлении.</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
          Обновить
        </button>
      )}
    </div>
  );
}

export function ProductGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true" aria-label="Загрузка">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="aspect-square w-full rounded-lg" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      ))}
    </div>
  );
}

export function PageSpinner({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div className="flex min-h-[50dvh] items-center justify-center" role="status" aria-live="polite">
      <span className="size-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
