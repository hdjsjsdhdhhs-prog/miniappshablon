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
              // Same size, padding and font weight in both states: selection only changes light, never layout.
              className={cn(
                'glass-panel glass-transition glass-press flex min-h-16 w-full items-center gap-3 rounded-xl p-2 pr-3 text-left',
                active ? 'glass-active text-foreground' : 'text-foreground/85 hover:border-(--glass-edge-strong) hover:text-foreground',
              )}
            >
              {/* Decorative: the tile is named by its text, not "Жидкости Жидкости". */}
              <span
                aria-hidden
                className={cn(
                  'glass-transition shrink-0 overflow-hidden rounded-lg ring-1 ring-(--glass-edge)',
                  active && 'ring-(--glass-accent-edge)',
                )}
              >
                <ProductImage path={c.imagePath} alt={c.name} className="size-12 bg-muted/60" sizes="48px" />
              </span>
              <span className="line-clamp-2 text-sm leading-snug font-medium tracking-[-0.005em]">{c.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
