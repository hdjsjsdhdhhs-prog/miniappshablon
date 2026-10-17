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
      className="glass-panel glass-transition rounded-full hover:border-(--glass-edge-strong) focus-within:border-(--glass-accent-edge) focus-within:shadow-[inset_0_1px_0_var(--glass-highlight),0_0_0_3px_var(--glass-focus),var(--glass-shadow)]"
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
        // The glass surface and focus state live on the <form>; the field itself is transparent.
        className="h-12 rounded-full border-0 bg-transparent pr-11 pl-11 text-base shadow-none placeholder:text-muted-foreground focus-visible:ring-0 md:text-[0.9375rem] dark:bg-transparent"
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
