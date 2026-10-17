import { ProductImage } from '@/components/product-image';
import { cn } from '@/lib/utils';
import type { Category } from '../api';

/**
 * Category tiles of the shop home page. Selecting a tile filters the product list below in place;
 * tapping the active tile again keeps it selected (it is a filter, not a toggle).
 */
export function CategoryTiles({
  categories,
  selected,
  onSelect,
}: {
  categories: Category[];
  selected: string | null;
  onSelect: (slug: string) => void;
}) {
  return (
    <ul className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-4" aria-label="Категории">
      {categories.map((c) => {
        const active = c.slug === selected;
        return (
          <li key={c.id}>
            <button
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(c.slug)}
              data-testid="category-tile"
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border bg-card p-2 pr-3 text-left transition-colors',
                active ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'hover:border-primary/60',
              )}
            >
              {/* Decorative: the tile is named by its text, not "Жидкости Жидкости". */}
              <span aria-hidden className="shrink-0">
                <ProductImage path={c.imagePath} alt={c.name} className="size-12 rounded-md" sizes="48px" />
              </span>
              <span className={cn('line-clamp-2 text-sm font-medium', active && 'font-semibold')}>{c.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
