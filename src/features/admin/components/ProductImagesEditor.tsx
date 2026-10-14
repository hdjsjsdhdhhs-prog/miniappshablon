import { ArrowDownIcon, ArrowUpIcon, StarIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { Tables } from '@/lib/supabase';
import { addProductImage, deleteProductImage, setPrimaryImage, updateProductImage } from '../api';
import { removeImageIfUnused, uploadShopImage } from '../media';
import { ImagePicker } from './ImagePicker';

type Img = Tables<'product_images'>;

export function ProductImagesEditor({
  shopId,
  productId,
  productName,
  images,
  queryKey,
}: {
  shopId: string;
  productId: string;
  productName: string;
  images: Img[];
  queryKey: readonly unknown[];
}) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: queryKey as unknown[] });
  const sorted = [...images].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));

  const move = async (index: number, dir: -1 | 1) => {
    const a = sorted[index];
    const b = sorted[index + dir];
    if (!a || !b) return;
    try {
      await updateProductImage(a.id, { sort_order: b.sort_order === a.sort_order ? a.sort_order + dir : b.sort_order });
      await updateProductImage(b.id, { sort_order: a.sort_order });
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      <ul className="space-y-3">
        {sorted.map((img, i) => (
          <li key={img.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3" data-testid="product-image-row">
            <ImagePicker
              path={img.storage_path}
              kind="product"
              label={`Фото ${i + 1}`}
              onUpload={async (file) => {
                const old = img.storage_path;
                const path = await uploadShopImage(shopId, 'product', productId, file);
                await updateProductImage(img.id, { storage_path: path });
                await removeImageIfUnused(shopId, old);
                await refresh();
              }}
              onRemove={async () => {
                await deleteProductImage(img.id);
                await removeImageIfUnused(shopId, img.storage_path);
                await refresh();
              }}
            />
            <div className="ml-auto flex gap-1">
              <Button
                type="button"
                variant={img.is_primary ? 'default' : 'outline'}
                size="sm"
                aria-pressed={img.is_primary}
                onClick={async () => {
                  try {
                    await setPrimaryImage(productId, img.id);
                    await refresh();
                  } catch (e) {
                    toast.error((e as Error).message);
                  }
                }}
              >
                <StarIcon aria-hidden weight={img.is_primary ? 'fill' : 'regular'} /> {img.is_primary ? 'Главное' : 'Сделать главным'}
              </Button>
              <Button type="button" variant="ghost" size="icon" aria-label="Выше" disabled={i === 0} onClick={() => void move(i, -1)}>
                <ArrowUpIcon aria-hidden />
              </Button>
              <Button type="button" variant="ghost" size="icon" aria-label="Ниже" disabled={i === sorted.length - 1} onClick={() => void move(i, 1)}>
                <ArrowDownIcon aria-hidden />
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {sorted.length < 10 && (
        <ImagePicker
          path={null}
          kind="product"
          label="Новое фото"
          onUpload={async (file) => {
            const path = await uploadShopImage(shopId, 'product', productId, file);
            const nextOrder = sorted.reduce((m, x) => Math.max(m, x.sort_order), -1) + 1;
            await addProductImage(shopId, productId, path, nextOrder, sorted.length === 0, productName);
            await refresh();
          }}
        />
      )}
    </div>
  );
}
