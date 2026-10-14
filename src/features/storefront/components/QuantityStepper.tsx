import { MinusIcon, PlusIcon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

export function QuantityStepper({
  value,
  min = 1,
  max,
  onChange,
  label = 'Количество',
  className,
}: {
  value: number;
  min?: number;
  max: number;
  onChange: (v: number) => void;
  label?: string;
  className?: string;
}) {
  const btn =
    'flex size-11 items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed';
  return (
    <div role="group" aria-label={label} className={cn('inline-flex items-center rounded-lg border bg-card', className)}>
      <button type="button" className={btn} aria-label="Уменьшить" disabled={value <= min} onClick={() => onChange(value - 1)}>
        <MinusIcon aria-hidden className="size-4" />
      </button>
      <output aria-live="polite" className="w-8 text-center text-sm font-semibold tabular-nums">
        {value}
      </output>
      <button type="button" className={btn} aria-label="Увеличить" disabled={value >= max} onClick={() => onChange(value + 1)}>
        <PlusIcon aria-hidden className="size-4" />
      </button>
    </div>
  );
}
