import { PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { findDuplicateCombos, variantFormSchema, variantLabel } from '@/domain/variants';
import type { Tables } from '@/lib/supabase';
import { createVariant, deleteVariant, setVariantStock, updateVariant } from '../api';
import { explainDeleteError } from '../delete-messages';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';

type Variant = Tables<'product_variants'>;

// A product has ONE price (products.base_price_minor) for every flavor/color. A variant row has no price
// field at all; creating or saving a variant never writes a price (see VariantInput in ../api).
interface RowDraft {
  flavor: string;
  color: string;
  sku: string;
  stock: string;
  isActive: boolean;
}

const toDraft = (v: Variant): RowDraft => ({
  flavor: v.flavor ?? '',
  color: v.color ?? '',
  sku: v.sku ?? '',
  stock: String(v.stock_quantity),
  isActive: v.is_active,
});

const EMPTY: RowDraft = { flavor: '', color: '', sku: '', stock: '0', isActive: true };

function parseRow(d: RowDraft) {
  const r = variantFormSchema.safeParse(d);
  if (!r.success) return { ok: false as const, error: r.error.issues[0]?.message ?? 'Ошибка' };
  return {
    ok: true as const,
    input: {
      flavor: r.data.flavor || null,
      color: r.data.color || null,
      sku: r.data.sku || null,
      is_active: r.data.isActive,
    },
    stock: r.data.stock,
  };
}

function VariantRow({ variant, onSaved, onDeleted }: { variant: Variant; onSaved: () => void; onDeleted: () => void }) {
  const [d, setD] = useState<RowDraft>(() => toDraft(variant));
  const dirty = JSON.stringify(d) !== JSON.stringify(toDraft(variant));
  const save = useMutation({
    mutationFn: async () => {
      const r = parseRow(d);
      if (!r.ok) throw new Error(r.error);
      await updateVariant(variant.id, r.input);
      if (r.stock !== variant.stock_quantity) await setVariantStock(variant.id, r.stock);
    },
    onSuccess: () => {
      toast.success('Вариант сохранён');
      onSaved();
    },
    onError: (e) => toast.error(e instanceof Error && /duplicate|unique/i.test(e.message) ? 'Такое сочетание вкус/цвет уже есть' : (e as Error).message),
  });
  const set = (k: keyof RowDraft) => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: e.target.value });

  const [deleteOpen, setDeleteOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteVariant(variant.id),
    onSuccess: () => {
      setDeleteOpen(false);
      toast.success('Вариант удалён');
      onDeleted();
    },
    onError: (e) => {
      if (explainDeleteError(e, 'variant').gone) onDeleted();
    },
  });
  const deactivate = useMutation({
    mutationFn: () => updateVariant(variant.id, { is_active: false }),
    onSuccess: () => {
      setDeleteOpen(false);
      toast.success('Вариант выключен');
      onSaved();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const deleteError = remove.isError ? explainDeleteError(remove.error, 'variant') : null;
  const label = variantLabel(variant) || 'Основной вариант';

  return (
    <TableRow data-testid="variant-row">
      <TableCell><Input aria-label="Вкус" value={d.flavor} onChange={set('flavor')} placeholder="—" /></TableCell>
      <TableCell><Input aria-label="Цвет" value={d.color} onChange={set('color')} placeholder="—" /></TableCell>
      <TableCell><Input aria-label="SKU" value={d.sku} onChange={set('sku')} placeholder="—" /></TableCell>
      <TableCell><Input aria-label="Остаток" value={d.stock} onChange={set('stock')} inputMode="numeric" className="w-24" data-testid="variant-stock" /></TableCell>
      <TableCell><Switch aria-label="Активен" checked={d.isActive} onCheckedChange={(v) => setD({ ...d, isActive: v })} /></TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()} data-testid="variant-save">
            {save.isPending ? '…' : 'Сохранить'}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            aria-label={`Удалить вариант ${label}`}
            title="Удалить вариант"
            onClick={() => {
              remove.reset();
              setDeleteOpen(true);
            }}
            data-testid="variant-delete"
          >
            <TrashIcon aria-hidden />
          </Button>
        </div>
        <ConfirmDeleteDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          testId="variant-delete-dialog"
          title={`Удалить вариант «${label}»?`}
          description="Вариант и его остаток будут удалены без возможности восстановления. Если вариант уже есть в заказах, удаление будет отменено — такой вариант можно только выключить."
          pending={remove.isPending}
          error={deleteError ? deleteError.text + (deleteError.suggest === 'deactivate' && !variant.is_active ? ' Вариант уже выключен.' : '') : null}
          alternative={
            deleteError?.suggest === 'deactivate' && variant.is_active ? (
              <Button variant="outline" disabled={deactivate.isPending} onClick={() => deactivate.mutate()} data-testid="variant-delete-deactivate">
                Выключить вариант
              </Button>
            ) : null
          }
          confirmDisabled={deleteError?.suggest === 'deactivate' || deleteError?.code === 'last_variant'}
          onConfirm={() => remove.mutate()}
        />
      </TableCell>
    </TableRow>
  );
}

export function VariantsEditor({ shopId, productId, variants, queryKey }: { shopId: string; productId: string; variants: Variant[]; queryKey: readonly unknown[] }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<RowDraft>(EMPTY);
  const refresh = () => void qc.invalidateQueries({ queryKey: queryKey as unknown[] });
  // A delete also changes the products list (variant count, stock) and the storefront.
  const refreshAll = () => {
    refresh();
    void qc.invalidateQueries({ queryKey: ['admin', 'shop', shopId] });
    void qc.invalidateQueries({ queryKey: ['shop', shopId] });
  };
  const add = useMutation({
    mutationFn: async () => {
      const r = parseRow(draft);
      if (!r.ok) throw new Error(r.error);
      const dupes = findDuplicateCombos([...variants, { flavor: r.input.flavor, color: r.input.color }]);
      if (dupes.length) throw new Error('Такое сочетание вкус/цвет уже есть');
      // A new variant sells at the product price (createVariant always stores no own price).
      await createVariant(shopId, productId, r.input, r.stock);
    },
    onSuccess: () => {
      setDraft(EMPTY);
      toast.success('Вариант добавлен');
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const sorted = [...variants].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
  const set = (k: keyof RowDraft) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: e.target.value });

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Каждое сочетание вкуса и цвета — отдельная позиция со своим остатком. Цена у всех вариантов одна — цена товара. Остаток меняется
        через журнал склада.
      </p>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Вкус</TableHead>
              <TableHead>Цвет</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Остаток</TableHead>
              <TableHead>Активен</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((v) => (
              <VariantRow key={`${v.id}:${v.updated_at}`} variant={v} onSaved={refresh} onDeleted={refreshAll} />
            ))}
            <TableRow>
              <TableCell><Input aria-label="Новый вкус" value={draft.flavor} onChange={set('flavor')} placeholder="Новый вкус" /></TableCell>
              <TableCell><Input aria-label="Новый цвет" value={draft.color} onChange={set('color')} placeholder="Новый цвет" /></TableCell>
              <TableCell><Input aria-label="Новый SKU" value={draft.sku} onChange={set('sku')} /></TableCell>
              <TableCell><Input aria-label="Остаток нового варианта" value={draft.stock} onChange={set('stock')} className="w-24" /></TableCell>
              <TableCell />
              <TableCell>
                <Button size="sm" variant="outline" disabled={add.isPending} onClick={() => add.mutate()}>
                  <PlusIcon aria-hidden /> Добавить
                </Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
