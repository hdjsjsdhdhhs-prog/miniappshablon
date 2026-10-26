import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { Input } from '@/components/ui/input';

export function ShopSearchInput({ value, onChange, placeholder = 'Название или slug' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="relative w-full sm:ml-auto sm:w-72">
      <MagnifyingGlassIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" aria-label="Поиск магазинов" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} className="pl-8" />
    </label>
  );
}
