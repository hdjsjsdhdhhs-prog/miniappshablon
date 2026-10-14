import { MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';

/** Debounced search input; emits trimmed values after 300 ms of inactivity. */
export function SearchBox({
  value,
  onChange,
  onSubmit,
  autoFocus,
}: {
  value: string;
  onChange?: (v: string) => void;
  onSubmit?: (v: string) => void;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  // Sync with external value changes (e.g. "reset filters") during render, not in an effect.
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    setDraft(value);
  }
  useEffect(() => {
    if (!onChange || draft === value) return;
    const t = window.setTimeout(() => onChange(draft.trim()), 300);
    return () => window.clearTimeout(t);
  }, [draft, onChange, value]);

  return (
    <form
      role="search"
      className="relative"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.(draft.trim());
        onChange?.(draft.trim());
      }}
    >
      <MagnifyingGlassIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        inputMode="search"
        enterKeyHint="search"
        aria-label="Поиск товаров"
        placeholder="Поиск товаров"
        maxLength={60}
        autoFocus={autoFocus}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="h-11 rounded-full bg-card pr-10 pl-10 text-base"
      />
      {draft && (
        <button
          type="button"
          aria-label="Очистить поиск"
          onClick={() => {
            setDraft('');
            onChange?.('');
          }}
          className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
        >
          <XIcon aria-hidden className="size-4" />
        </button>
      )}
    </form>
  );
}
