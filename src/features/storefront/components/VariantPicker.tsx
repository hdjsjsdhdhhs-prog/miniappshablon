import { isOptionAvailable, variantOptions, type VariantLike, type VariantSelection } from '@/domain/variants';
import { cn } from '@/lib/utils';

function OptionGroup({
  label,
  kind,
  values,
  variants,
  selection,
  onChange,
}: {
  label: string;
  kind: 'flavor' | 'color';
  values: string[];
  variants: readonly VariantLike[];
  selection: VariantSelection;
  onChange: (s: VariantSelection) => void;
}) {
  const other = kind === 'flavor' ? selection.color : selection.flavor;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {values.map((value) => {
          const { exists, inStock } = isOptionAvailable(variants, kind, value, other);
          const fallback = isOptionAvailable(variants, kind, value, null);
          const active = selection[kind] === value;
          const unavailable = !exists && !fallback.exists;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={unavailable}
              onClick={() => {
                // If the combination with the other option does not exist, switch the other option
                // to the first existing one so the selection always maps to a real variant.
                if (exists) {
                  onChange({ ...selection, [kind]: value });
                } else {
                  const v = variants.find((x) => x.is_active && x[kind] === value);
                  if (v) onChange({ flavor: v.flavor, color: v.color });
                }
              }}
              className={cn(
                'min-h-11 rounded-lg border px-3 py-2 text-sm transition-colors',
                active ? 'border-primary bg-primary/15 font-medium' : 'bg-card hover:border-primary/60',
                !inStock && 'text-muted-foreground line-through decoration-1',
                'disabled:cursor-not-allowed disabled:opacity-40',
              )}
            >
              {value}
              {!inStock && <span className="sr-only"> — нет в наличии</span>}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function VariantPicker({
  variants,
  selection,
  onChange,
}: {
  variants: readonly VariantLike[];
  selection: VariantSelection;
  onChange: (s: VariantSelection) => void;
}) {
  const { flavors, colors } = variantOptions(variants);
  if (flavors.length === 0 && colors.length === 0) return null;
  return (
    <div className="space-y-4" data-testid="variant-picker">
      {flavors.length > 0 && (
        <OptionGroup label="Вкус" kind="flavor" values={flavors} variants={variants} selection={selection} onChange={onChange} />
      )}
      {colors.length > 0 && (
        <OptionGroup label="Цвет" kind="color" values={colors} variants={variants} selection={selection} onChange={onChange} />
      )}
    </div>
  );
}
