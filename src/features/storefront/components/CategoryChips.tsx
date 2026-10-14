import { cn } from '@/lib/utils';
import type { Category } from '../api';

/** Horizontal, scrollable category selector (radio-group semantics). */
export function CategoryChips({
  categories,
  selected,
  onSelect,
}: {
  categories: Category[];
  selected: string | null;
  onSelect: (slug: string | null) => void;
}) {
  const chip = (active: boolean) =>
    cn(
      'shrink-0 rounded-full border px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors min-h-10',
      active ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:border-primary/60',
    );
  return (
    <div role="radiogroup" aria-label="Категории" className="scrollbar-none flex gap-2 overflow-x-auto px-4 py-1">
      <button type="button" role="radio" aria-checked={selected === null} className={chip(selected === null)} onClick={() => onSelect(null)}>
        Все
      </button>
      {categories.map((c) => (
        <button
          key={c.id}
          type="button"
          role="radio"
          aria-checked={selected === c.slug}
          className={chip(selected === c.slug)}
          onClick={() => onSelect(c.slug)}
        >
          {c.name}
        </button>
      ))}
    </div>
  );
}
