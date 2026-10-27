import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ErrorState, PageSpinner } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { queryKeys } from '@/domain/query-keys';
import { CATEGORY_SLUG_RE as SLUG, slugify } from '@/domain/slugify';
import { useAdminShop } from '../admin-context';
import { createCategory, deleteCategory, fetchAdminCategories, fetchAdminProducts, updateCategory, type AdminCategory } from '../api';
import { ConfirmDeleteDialog } from '../components/ConfirmDeleteDialog';
import { ImagePicker } from '../components/ImagePicker';
import { explainDeleteError, ru } from '../delete-messages';
import { removeImageIfUnused, uploadShopImage } from '../media';

function DeleteCategoryDialog({
  cat,
  productCount,
  targets,
  open,
  onOpenChange,
  onArchive,
}: {
  cat: AdminCategory;
  /** From the cached products list; the server re-counts and refuses if it is stale. */
  productCount: number;
  targets: AdminCategory[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive: () => void;
}) {
  const shop = useAdminShop();
  const qc = useQueryClient();
  const [moveTo, setMoveTo] = useState('');
  const remove = useMutation({
    mutationFn: () => deleteCategory(cat.id, moveTo || undefined),
    onSuccess: async (r) => {
      onOpenChange(false);
      await qc.invalidateQueries({ queryKey: ['admin', 'shop', shop.id] });
      void qc.invalidateQueries({ queryKey: ['shop', shop.id] });
      const target = targets.find((t) => t.id === r.moved_to);
      toast.success(
        r.moved_products > 0 && target
          ? `Категория удалена. ${r.moved_products} ${ru(r.moved_products, 'товар перенесён', 'товара перенесено', 'товаров перенесено')} в «${target.name}»`
          : 'Категория удалена',
      );
      if (r.media.failed) toast.warning('Категория удалена, но её изображение не удалось убрать из хранилища.');
    },
    onError: (e) => {
      if (explainDeleteError(e, 'category').gone) void qc.invalidateQueries({ queryKey: ['admin', 'shop', shop.id] });
    },
  });
  const err = remove.isError ? explainDeleteError(remove.error, 'category') : null;
  // Products must be moved when the list says so, or when the server said so (the list was stale).
  const needsMove = productCount > 0 || err?.suggest === 'move';

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      testId="category-delete-dialog"
      title={`Удалить категорию «${cat.name}»?`}
      description={
        needsMove
          ? 'Категория будет удалена без возможности восстановления. Товары не удаляются: в той же операции они переносятся в выбранную категорию.'
          : 'В категории нет товаров. Она будет удалена без возможности восстановления вместе со своим изображением.'
      }
      pending={remove.isPending}
      error={err?.text ?? null}
      alternative={
        needsMove && !cat.archived_at ? (
          <Button variant="outline" onClick={onArchive} data-testid="category-delete-archive">
            В архив
          </Button>
        ) : null
      }
      confirmDisabled={needsMove && !moveTo}
      onConfirm={() => remove.mutate()}
    >
      {needsMove && (
        <div className="space-y-1.5" data-testid="category-delete-move">
          {productCount > 0 && (
            <p className="text-sm" data-testid="category-delete-count">
              В категории {productCount} {ru(productCount, 'товар', 'товара', 'товаров')} (включая архивные).
            </p>
          )}
          {targets.length > 0 ? (
            <>
              <Label htmlFor={`move-${cat.id}`}>Перенести товары в</Label>
              <Select value={moveTo} onValueChange={setMoveTo}>
                <SelectTrigger id={`move-${cat.id}`} className="w-full" data-testid="category-delete-target">
                  <SelectValue placeholder="Выберите категорию" />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                      {!t.is_active && ' (скрыта)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="category-delete-no-target">
              Других категорий нет, переносить товары некуда. Создайте новую категорию или отправьте эту в архив.
            </p>
          )}
        </div>
      )}
    </ConfirmDeleteDialog>
  );
}

function CategoryRow({
  cat,
  index,
  total,
  onMove,
  productCount,
  targets,
}: {
  cat: AdminCategory;
  index: number;
  total: number;
  onMove: (dir: -1 | 1) => void;
  productCount: number;
  targets: AdminCategory[];
}) {
  const shop = useAdminShop();
  const qc = useQueryClient();
  const [name, setName] = useState(cat.name);
  const [slug, setSlug] = useState(cat.slug);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.adminCategories(shop.id) });
    void qc.invalidateQueries({ queryKey: ['shop', shop.id] });
  };
  const save = useMutation({
    mutationFn: (patch: Parameters<typeof updateCategory>[1]) => updateCategory(cat.id, patch),
    onSuccess: () => {
      toast.success('Категория сохранена');
      refresh();
    },
    onError: (e) => toast.error(/unique|duplicate/i.test((e as Error).message) ? 'Такой slug уже есть' : (e as Error).message),
  });
  const archived = !!cat.archived_at;
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3" data-testid="category-row">
      <ImagePicker
        path={cat.image_path}
        kind="category"
        label={`Изображение ${cat.name}`}
        onUpload={async (file) => {
          const path = await uploadShopImage(shop.id, 'category', cat.id, file);
          const old = cat.image_path;
          await updateCategory(cat.id, { image_path: path });
          await removeImageIfUnused(shop.id, old);
          refresh();
        }}
        onRemove={async () => {
          const old = cat.image_path;
          await updateCategory(cat.id, { image_path: null });
          await removeImageIfUnused(shop.id, old);
          refresh();
        }}
      />
      <div className="grid min-w-60 flex-1 gap-2 sm:grid-cols-2">
        <Input aria-label="Название" value={name} onChange={(e) => setName(e.target.value)} />
        <Input aria-label="Slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
      </div>
      <div className="flex items-center gap-2">
        {archived && <Badge variant="outline">архив</Badge>}
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={cat.is_active} disabled={archived} onCheckedChange={(v) => save.mutate({ is_active: v })} /> Видна
        </label>
        <Button
          size="sm"
          disabled={save.isPending || (name === cat.name && slug === cat.slug)}
          onClick={() => {
            if (!name.trim()) return toast.error('Название обязательно');
            if (!SLUG.test(slug)) return toast.error('Slug: латиница, цифры, дефис');
            save.mutate({ name: name.trim(), slug });
          }}
        >
          Сохранить
        </Button>
        <Button size="icon" variant="ghost" aria-label="Выше" disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUpIcon aria-hidden />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Ниже" disabled={index === total - 1} onClick={() => onMove(1)}>
          <ArrowDownIcon aria-hidden />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => save.mutate({ archived_at: archived ? null : new Date().toISOString(), is_active: archived })}>
          {archived ? 'Вернуть' : 'В архив'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
          data-testid="category-delete"
        >
          <TrashIcon aria-hidden /> Удалить
        </Button>
      </div>
      {/* Mounted only while open: every opening starts with a clean form and no stale server error. */}
      {deleteOpen && (
        <DeleteCategoryDialog
          cat={cat}
          productCount={productCount}
          targets={targets}
          open
          onOpenChange={setDeleteOpen}
          onArchive={() => {
            save.mutate({ archived_at: new Date().toISOString(), is_active: false });
            setDeleteOpen(false);
          }}
        />
      )}
    </li>
  );
}

export function CategoriesPage() {
  const shop = useAdminShop();
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: queryKeys.adminCategories(shop.id), queryFn: () => fetchAdminCategories(shop.id) });
  // Same query as the products page (shared cache): lets the delete dialog show how many products would move.
  const products = useQuery({ queryKey: queryKeys.adminProducts(shop.id), queryFn: () => fetchAdminProducts(shop.id) });
  const productCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of products.data ?? []) m.set(p.category_id, (m.get(p.category_id) ?? 0) + 1);
    return m;
  }, [products.data]);
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const slug = slugify(name) || `cat-${Date.now().toString(36)}`;
      return createCategory(shop.id, { name: name.trim(), slug, sort_order: (cats.data?.length ?? 0) + 1 });
    },
    onSuccess: () => {
      setName('');
      toast.success('Категория создана');
      void qc.invalidateQueries({ queryKey: queryKeys.adminCategories(shop.id) });
      void qc.invalidateQueries({ queryKey: ['shop', shop.id] });
    },
    onError: (e) => toast.error(/unique|duplicate/i.test((e as Error).message) ? 'Категория с таким slug уже есть' : (e as Error).message),
  });

  if (cats.isPending) return <PageSpinner />;
  if (cats.isError) return <ErrorState onRetry={() => void cats.refetch()} />;
  const list = cats.data;

  const move = async (index: number, dir: -1 | 1) => {
    const a = list[index];
    const b = list[index + dir];
    if (!a || !b) return;
    try {
      // Normalize order to the current visual order, then swap the two neighbours.
      await Promise.all(
        list.map((c, i) => {
          const target = i === index ? index + dir : i === index + dir ? index : i;
          return c.sort_order === target ? null : updateCategory(c.id, { sort_order: target });
        }),
      );
      void qc.invalidateQueries({ queryKey: queryKeys.adminCategories(shop.id) });
      void qc.invalidateQueries({ queryKey: ['shop', shop.id] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <div className="min-w-60 flex-1 space-y-1.5">
          <Label htmlFor="new-cat">Новая категория</Label>
          <Input id="new-cat" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </div>
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          <PlusIcon aria-hidden /> Создать
        </Button>
      </form>
      <ul className="space-y-2">
        {list.map((c, i) => (
          <CategoryRow
            key={`${c.id}:${c.updated_at}`}
            cat={c}
            index={i}
            total={list.length}
            onMove={(d) => void move(i, d)}
            productCount={productCounts.get(c.id) ?? 0}
            targets={list.filter((t) => t.id !== c.id && !t.archived_at)}
          />
        ))}
      </ul>
    </div>
  );
}
