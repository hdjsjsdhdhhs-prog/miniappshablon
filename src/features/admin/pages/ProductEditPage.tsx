import { zodResolver } from '@hookform/resolvers/zod';
import { ArchiveIcon, ArrowCounterClockwiseIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { EmptyState, ErrorState, PageSpinner } from '@/components/state-views';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { minorToInput, parseMoneyInput } from '@/domain/money';
import { queryKeys } from '@/domain/query-keys';
import { useAdminShop } from '../admin-context';
import { createProduct, fetchAdminCategories, fetchAdminProduct, updateProduct, type AdminProduct } from '../api';
import { ProductImagesEditor } from '../components/ProductImagesEditor';
import { VariantsEditor } from '../components/VariantsEditor';

const schema = z.object({
  name: z.string().trim().min(1, 'Укажите название').max(120),
  description: z.string().max(4000),
  categoryId: z.string().min(1, 'Выберите категорию'),
  price: z.string().refine((v) => parseMoneyInput(v) !== null, 'Цена в формате 1290 или 1290,50'),
  isPublished: z.boolean(),
  isFeatured: z.boolean(),
  sortOrder: z.coerce.number().int().min(-100000).max(100000),
});
type FormValues = z.input<typeof schema>;

function ProductForm({ product, onSaved }: { product: AdminProduct | null; onSaved: (id: string) => void }) {
  const shop = useAdminShop();
  const qc = useQueryClient();
  const categories = useQuery({ queryKey: queryKeys.adminCategories(shop.id), queryFn: () => fetchAdminCategories(shop.id) });
  const form = useForm<FormValues, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: product?.name ?? '',
      description: product?.description ?? '',
      categoryId: product?.category_id ?? '',
      price: product ? minorToInput(product.base_price_minor) : '',
      isPublished: product?.is_published ?? false,
      isFeatured: product?.is_featured ?? false,
      sortOrder: product?.sort_order ?? 0,
    },
  });
  const { errors, isSubmitting, isDirty } = form.formState;

  const submit = form.handleSubmit(async (v) => {
    const input = {
      name: v.name,
      description: v.description,
      category_id: v.categoryId,
      base_price_minor: parseMoneyInput(v.price)!,
      is_published: v.isPublished,
      is_featured: v.isFeatured,
      sort_order: v.sortOrder,
    };
    try {
      const saved = product ? await updateProduct(product.id, input) : await createProduct(shop.id, input);
      await qc.invalidateQueries({ queryKey: ['admin', 'shop', shop.id] });
      await qc.invalidateQueries({ queryKey: ['shop', shop.id] });
      toast.success('Товар сохранён');
      form.reset(v);
      onSaved(saved.id);
    } catch (e) {
      toast.error((e as Error).message);
    }
  });

  const activeCats = (categories.data ?? []).filter((c) => !c.archived_at);
  return (
    <form noValidate onSubmit={submit} className="grid gap-4 md:grid-cols-2" aria-label="Карточка товара">
      <div className="space-y-1.5 md:col-span-2">
        <Label htmlFor="pf-name">Название</Label>
        <Input id="pf-name" aria-invalid={!!errors.name} {...form.register('name')} />
        {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
      </div>
      <div className="space-y-1.5 md:col-span-2">
        <Label htmlFor="pf-desc">Описание</Label>
        <Textarea id="pf-desc" rows={4} {...form.register('description')} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pf-cat">Категория</Label>
        <Controller
          control={form.control}
          name="categoryId"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="pf-cat" className="w-full" aria-invalid={!!errors.categoryId}>
                <SelectValue placeholder="Выберите" />
              </SelectTrigger>
              <SelectContent>
                {activeCats.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    {!c.is_active && ' (скрыта)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {errors.categoryId && <p className="text-sm text-destructive">{errors.categoryId.message}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pf-price">Базовая цена, {shop.currency}</Label>
        <Input id="pf-price" inputMode="decimal" aria-invalid={!!errors.price} {...form.register('price')} data-testid="product-price-input" />
        {errors.price && <p className="text-sm text-destructive">{errors.price.message}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pf-sort">Порядок</Label>
        <Input id="pf-sort" inputMode="numeric" {...form.register('sortOrder')} />
      </div>
      <div className="flex items-center gap-6 pt-6">
        <Controller
          control={form.control}
          name="isPublished"
          render={({ field }) => (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={field.value} onCheckedChange={field.onChange} /> Опубликован
            </label>
          )}
        />
        <Controller
          control={form.control}
          name="isFeatured"
          render={({ field }) => (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={field.value} onCheckedChange={field.onChange} /> Рекомендуемый
            </label>
          )}
        />
      </div>
      <div className="md:col-span-2">
        <Button type="submit" disabled={isSubmitting || (!!product && !isDirty)} data-testid="product-save">
          {isSubmitting ? 'Сохраняем…' : product ? 'Сохранить' : 'Создать товар'}
        </Button>
      </div>
    </form>
  );
}

export function ProductEditPage() {
  const shop = useAdminShop();
  const { productId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isNew = productId === 'new';
  const key = queryKeys.adminProduct(shop.id, productId);
  const product = useQuery({ queryKey: key, queryFn: () => fetchAdminProduct(shop.id, productId), enabled: !isNew });

  const archive = useMutation({
    mutationFn: (archived: boolean) => updateProduct(productId, { archived_at: archived ? new Date().toISOString() : null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'shop', shop.id] });
      void qc.invalidateQueries({ queryKey: ['shop', shop.id] });
      toast.success('Готово');
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (isNew) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Новый товар</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductForm product={null} onSaved={(id) => navigate(`../products/${id}`, { replace: true, relative: 'path' })} />
        </CardContent>
      </Card>
    );
  }
  if (product.isPending) return <PageSpinner />;
  if (product.isError) return <ErrorState onRetry={() => void product.refetch()} />;
  if (!product.data) {
    return <EmptyState title="Товар не найден" action={<Button asChild variant="outline"><Link to="..">К товарам</Link></Button>} />;
  }
  const p = product.data;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to={`/admin/shops/${shop.slug}/products`}>← Все товары</Link>
        </Button>
        <div className="ml-auto">
          {p.archived_at ? (
            <Button variant="outline" size="sm" onClick={() => archive.mutate(false)}>
              <ArrowCounterClockwiseIcon aria-hidden /> Вернуть из архива
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => archive.mutate(true)}>
              <ArchiveIcon aria-hidden /> В архив
            </Button>
          )}
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Карточка товара</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductForm key={p.updated_at} product={p} onSaved={() => void qc.invalidateQueries({ queryKey: key })} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Варианты: вкусы, цвета, цены и остатки</CardTitle>
        </CardHeader>
        <CardContent>
          <VariantsEditor shopId={shop.id} productId={p.id} variants={p.product_variants} queryKey={key} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Фотографии</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductImagesEditor shopId={shop.id} productId={p.id} productName={p.name} images={p.product_images} queryKey={key} />
        </CardContent>
      </Card>
    </div>
  );
}
