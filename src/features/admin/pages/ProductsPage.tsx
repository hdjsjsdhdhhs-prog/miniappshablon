import { PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ProductImage } from '@/components/product-image';
import { EmptyState, ErrorState, PageSpinner } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatMoney } from '@/domain/money';
import { queryKeys } from '@/domain/query-keys';
import { useAdminShop } from '../admin-context';
import { fetchAdminCategories, fetchAdminProducts } from '../api';

export function ProductsPage() {
  const shop = useAdminShop();
  const products = useQuery({ queryKey: queryKeys.adminProducts(shop.id), queryFn: () => fetchAdminProducts(shop.id) });
  const categories = useQuery({ queryKey: queryKeys.adminCategories(shop.id), queryFn: () => fetchAdminCategories(shop.id) });
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const catName = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, c.name])), [categories.data]);
  const rows = useMemo(
    () =>
      (products.data ?? []).filter(
        (p) => (showArchived || !p.archived_at) && p.name.toLowerCase().includes(q.trim().toLowerCase()),
      ),
    [products.data, q, showArchived],
  );

  if (products.isPending) return <PageSpinner />;
  if (products.isError) return <ErrorState onRetry={() => void products.refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor="p-search">Поиск</Label>
          <Input id="p-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название товара" />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch id="p-archived" checked={showArchived} onCheckedChange={setShowArchived} />
          <Label htmlFor="p-archived">Архив</Label>
        </div>
        <Button asChild>
          <Link to="new">
            <PlusIcon aria-hidden /> Новый товар
          </Link>
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Товаров нет" description="Создайте первый товар или измените фильтр." />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Фото</TableHead>
                <TableHead>Название</TableHead>
                <TableHead>Категория</TableHead>
                <TableHead className="text-right">Цена</TableHead>
                <TableHead className="text-right">Остаток</TableHead>
                <TableHead>Статус</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => {
                const primary = [...p.product_images].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.sort_order - b.sort_order)[0];
                const stock = p.product_variants.filter((v) => v.is_active).reduce((n, v) => n + v.stock_quantity, 0);
                return (
                  <TableRow key={p.id}>
                    <TableCell>
                      <ProductImage path={primary?.storage_path} alt={p.name} className="size-10 rounded" sizes="40px" />
                    </TableCell>
                    <TableCell>
                      <Link to={p.id} className="font-medium hover:underline" data-testid="admin-product-link">
                        {p.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">вариантов: {p.product_variants.length}</p>
                    </TableCell>
                    <TableCell>{catName.get(p.category_id) ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(p.base_price_minor, shop.currency)}</TableCell>
                    <TableCell className="text-right tabular-nums">{stock}</TableCell>
                    <TableCell>
                      {p.archived_at ? (
                        <Badge variant="outline">архив</Badge>
                      ) : p.is_published ? (
                        <Badge>опубликован</Badge>
                      ) : (
                        <Badge variant="secondary">скрыт</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
