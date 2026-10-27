import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { slugify } from '@/domain/slugify';
import { SLUG_RE } from '@/domain/tenant-config';
import { AdminApiError, platformApi, publicShopUrl, type CreatedDemoShop, type PlatformShop } from '../functions-api';
import { CopyLinkButton } from './CopyLinkButton';

/**
 * Template used when nothing else is chosen: the original DEMO storefront, i.e. the oldest active DEMO shop.
 * Chosen by data, not by slug — tenant names never live in src/ (pnpm check:tenant-names).
 */
function defaultTemplateOf(templates: PlatformShop[]): PlatformShop | undefined {
  return templates.reduce<PlatformShop | undefined>((oldest, s) => (!oldest || s.created_at < oldest.created_at ? s : oldest), undefined);
}

const ERRORS: Record<string, string> = {
  slug_taken: 'Этот адрес (slug) уже занят другим магазином. Выберите другой.',
  invalid_slug: 'Slug: 3–40 символов — латиница a–z, цифры и дефис, без дефиса в начале и в конце.',
  invalid_name: 'Название: от 1 до 80 символов.',
  template_not_found: 'Шаблон не найден или больше не является DEMO-магазином.',
  media_copy_failed: 'Не удалось скопировать изображения шаблона. Магазин не создан — повторите попытку.',
  forbidden: 'Создавать магазины может только администратор платформы.',
  invalid_body: 'Проверьте название и slug.',
  auth_required: 'Сессия истекла. Войдите снова.',
  network_error: 'Нет связи с сервером. Повторите попытку.',
};
const errorText = (e: unknown) => (e instanceof AdminApiError && ERRORS[e.code]) || 'Не удалось создать магазин. Повторите попытку.';

/**
 * "Создать DEMO-магазин": a separate tenant (own shop_id) cloned on the server from a DEMO template. No build,
 * no config file: the shop appears in Supabase, goes live as DEMO and is reachable at /s/<slug>/ right away.
 */
export function CreateDemoDialog({ shops, open, onOpenChange }: { shops: PlatformShop[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const templates = shops.filter((s) => s.is_demo && s.status === 'active');
  const defaultTemplate = defaultTemplateOf(templates);
  const [templateId, setTemplateId] = useState(defaultTemplate?.id ?? '');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [created, setCreated] = useState<CreatedDemoShop | null>(null);

  const normalizedSlug = slug.trim().toLowerCase();
  const slugValid = SLUG_RE.test(normalizedSlug);
  const slugTaken = shops.some((s) => s.slug === normalizedSlug);
  const canSubmit = !!templateId && name.trim().length > 0 && slugValid && !slugTaken;

  const create = useMutation({
    mutationFn: () => platformApi.createDemo({ templateId, slug: normalizedSlug, name: name.trim() }),
    onSuccess: async (r) => {
      setCreated(r);
      await qc.invalidateQueries({ queryKey: ['admin'] });
    },
  });

  const close = (next: boolean) => {
    if (!next) {
      setName('');
      setSlug('');
      setSlugTouched(false);
      setCreated(null);
      create.reset();
    }
    onOpenChange(next);
  };

  const url = created ? publicShopUrl(created.shop.slug) : '';

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent data-testid="create-demo-dialog">
        <DialogHeader>
          <DialogTitle>Создать DEMO-магазин</DialogTitle>
          <DialogDescription>
            Отдельный магазин с собственным shop_id на основе DEMO-шаблона: каталог, фото, оформление. Покупатели видят баннер
            DEMO, демо-профиль и тестовый заказ; настоящие заказы не создаются.
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3 text-sm" data-testid="create-demo-result">
            <Alert>
              <AlertDescription>
                Магазин «{created.shop.name}» создан и опубликован как DEMO.
                {created.media.missing > 0 && ` В шаблоне не нашлось ${created.media.missing} изображений — они показаны заглушкой.`}
              </AlertDescription>
            </Alert>
            <div className="space-y-1.5">
              <Label htmlFor="demo-url">Публичная ссылка</Label>
              <Input id="demo-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" data-testid="create-demo-url" />
              <div className="flex flex-wrap gap-2">
                <CopyLinkButton url={url} testId="create-demo-copy" />
                <Button asChild size="sm" variant="ghost">
                  <a href={url} target="_blank" rel="noreferrer">
                    Открыть витрину
                  </a>
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <form
            id="create-demo-form"
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) create.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="demo-name">Название магазина</Label>
              <Input
                id="demo-name"
                value={name}
                maxLength={80}
                autoComplete="off"
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value).slice(0, 40).replace(/-+$/, ''));
                }}
                data-testid="create-demo-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="demo-slug">Slug (адрес витрины)</Label>
              <Input
                id="demo-slug"
                value={slug}
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                aria-invalid={(slug !== '' && !slugValid) || slugTaken || undefined}
                aria-describedby="demo-slug-hint"
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
                data-testid="create-demo-slug"
              />
              <p id="demo-slug-hint" className={(slug && !slugValid) || slugTaken ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                {slugTaken
                  ? 'Этот slug уже занят.'
                  : slug && !slugValid
                    ? '3–40 символов: a–z, 0–9 и дефис, без дефиса в начале и в конце.'
                    : `Ссылка: ${publicShopUrl(normalizedSlug || '<slug>')}`}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="demo-template">Шаблон</Label>
              {templates.length === 0 ? (
                <p className="text-sm text-destructive">Нет активных DEMO-магазинов, которые можно использовать как шаблон.</p>
              ) : (
                <Select value={templateId} onValueChange={setTemplateId}>
                  <SelectTrigger id="demo-template" className="w-full" data-testid="create-demo-template">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} ({t.slug})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {create.isError && (
              <Alert variant="destructive" data-testid="create-demo-error">
                <AlertDescription>{errorText(create.error)}</AlertDescription>
              </Alert>
            )}
          </form>
        )}

        <DialogFooter>
          {created ? (
            <Button onClick={() => close(false)}>Готово</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => close(false)}>
                Отмена
              </Button>
              <Button type="submit" form="create-demo-form" disabled={!canSubmit || create.isPending} data-testid="create-demo-submit">
                {create.isPending ? 'Создаём…' : 'Создать'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
