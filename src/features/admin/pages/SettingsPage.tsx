import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/domain/query-keys';
import {
  DEFAULT_TELEGRAM_CHANNEL_LABEL,
  normalizeTelegramChannelUrl,
  TELEGRAM_CHANNEL_LABEL_MAX,
  telegramChannelLabel,
} from '@/domain/telegram-link';
import { shopInformationSchema, shopSettingsSchema } from '@/domain/tenant-config';
import { parseTheme, THEME_COLOR_KEYS, themeContrastIssues, themeSchema, themeToCssVars, type ShopTheme, type ThemeColorKey } from '@/domain/theme';
import { useAdminShop } from '../admin-context';
import { updateShopSettings } from '../api';
import { ImagePicker } from '../components/ImagePicker';
import { removeImageIfUnused, uploadShopImage } from '../media';

const COLOR_LABELS: Record<ThemeColorKey, string> = {
  background: 'Фон',
  foreground: 'Текст',
  card: 'Карточки',
  cardForeground: 'Текст карточек',
  primary: 'Основной (кнопки)',
  primaryForeground: 'Текст на основном',
  accent: 'Акцент',
  accentForeground: 'Текст на акценте',
  muted: 'Приглушённый фон',
  mutedForeground: 'Второстепенный текст',
  border: 'Границы',
};

const INFO_LABELS = { address: 'Адрес', hours: 'Часы работы', delivery: 'Получение', payment: 'Оплата', phone: 'Телефон', telegram: 'Telegram' } as const;
// `settings.showFeatured` is still stored (strict schema, existing data) but the storefront has no featured block anymore.
const SETTINGS_LABELS = { showCategories: 'Показывать категории', showInfo: 'Показывать блок «О магазине»' } as const;

function ThemePreview({ theme, name }: { theme: ShopTheme; name: string }) {
  return (
    <div style={themeToCssVars(theme) as React.CSSProperties} className="space-y-3 rounded-lg border bg-background p-4 text-foreground" aria-label="Предпросмотр темы">
      <p className="font-semibold">{name}</p>
      <div className="rounded-lg border bg-card p-3 text-card-foreground">
        <p className="text-sm">Карточка товара</p>
        <p className="text-xs text-muted-foreground">Второстепенный текст</p>
      </div>
      <div className="flex gap-2">
        <span className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground">В корзину</span>
        <span className="rounded-md bg-accent px-3 py-1.5 text-sm text-accent-foreground">Акцент</span>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const shop = useAdminShop();
  const qc = useQueryClient();
  const [name, setName] = useState(shop.name);
  const [description, setDescription] = useState(shop.description);
  const [legal, setLegal] = useState(shop.legal_notice);
  const [theme, setTheme] = useState<ShopTheme>(() => parseTheme(shop.theme_config));
  const [info, setInfo] = useState(() => shopInformationSchema.parse(shopInformationSchema.safeParse(shop.info).data ?? {}));
  const [settings, setSettings] = useState(() => shopSettingsSchema.parse(shopSettingsSchema.safeParse(shop.settings).data ?? {}));
  // An empty stored label means "default text", so the owner sees (and can edit) the actual button text.
  const [channelLabel, setChannelLabel] = useState(() => telegramChannelLabel(info.telegramChannelLabel));
  const channelUrl = info.telegramChannelUrl;
  const channelUrlInvalid = !!channelUrl.trim() && !normalizeTelegramChannelUrl(channelUrl);
  const issues = themeContrastIssues(theme);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: queryKeys.adminShop(shop.slug) });
    await qc.invalidateQueries({ queryKey: queryKeys.shop(shop.slug) });
  };

  const save = useMutation({
    mutationFn: async () => {
      const t = themeSchema.safeParse(theme);
      if (!t.success) throw new Error('Проверьте цвета темы (#RRGGBB)');
      if (!name.trim()) throw new Error('Название обязательно');
      const url = channelUrl.trim() ? normalizeTelegramChannelUrl(channelUrl) : '';
      if (url === null) throw new Error('Ссылка на канал: укажите https://t.me/<канал> или https://t.me/+<приглашение>');
      const label = channelLabel.trim().slice(0, TELEGRAM_CHANNEL_LABEL_MAX);
      const nextInfo = {
        ...info,
        telegramChannelUrl: url,
        // Default text is stored as '' so a future change of the platform default reaches untouched shops.
        telegramChannelLabel: label === DEFAULT_TELEGRAM_CHANNEL_LABEL ? '' : label,
      };
      return updateShopSettings(shop.id, { name: name.trim(), description, legal_notice: legal, theme_config: t.data, info: nextInfo, settings });
    },
    onSuccess: async (saved) => {
      // Show the canonical link (e.g. "@channel" → "https://t.me/channel") that was actually stored.
      const stored = shopInformationSchema.safeParse(saved.info);
      if (stored.success) setInfo(stored.data);
      toast.success('Сохранено. Витрина обновится без новой сборки.');
      await refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const imageHandlers = (field: 'logo_path' | 'cover_path', entity: 'logo' | 'cover') => ({
    onUpload: async (file: File) => {
      const old = shop[field];
      const path = await uploadShopImage(shop.id, entity, shop.id, file);
      await updateShopSettings(shop.id, { [field]: path });
      await removeImageIfUnused(shop.id, old);
      await refresh();
    },
    onRemove: async () => {
      const old = shop[field];
      await updateShopSettings(shop.id, { [field]: null });
      await removeImageIfUnused(shop.id, old);
      await refresh();
    },
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <Card>
          <CardHeader><CardTitle>Магазин</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="s-name">Название</Label>
              <Input id="s-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-testid="settings-name" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-desc">Описание</Label>
              <Textarea id="s-desc" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Логотип</Label>
              <ImagePicker path={shop.logo_path} kind="logo" label="Логотип" {...imageHandlers('logo_path', 'logo')} />
            </div>
            <div className="space-y-2">
              <Label>Обложка</Label>
              <ImagePicker path={shop.cover_path} kind="cover" label="Обложка" {...imageHandlers('cover_path', 'cover')} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Палитра</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={theme.mode === 'dark'} onCheckedChange={(v) => setTheme({ ...theme, mode: v ? 'dark' : 'light' })} /> Тёмная тема
              </label>
              <label className="flex items-center gap-2 text-sm">
                Скругление
                <input type="range" min={0} max={28} value={theme.radius} onChange={(e) => setTheme({ ...theme, radius: Number(e.target.value) })} aria-label="Скругление углов" />
                <span className="tabular-nums">{theme.radius}px</span>
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {THEME_COLOR_KEYS.map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={COLOR_LABELS[k]}
                    value={theme[k]}
                    onChange={(e) => setTheme({ ...theme, [k]: e.target.value })}
                    className="size-9 shrink-0 cursor-pointer rounded border"
                  />
                  <Input aria-label={`${COLOR_LABELS[k]} (hex)`} value={theme[k]} onChange={(e) => setTheme({ ...theme, [k]: e.target.value })} className="w-28 font-mono" />
                  <span className="text-sm">{COLOR_LABELS[k]}</span>
                </div>
              ))}
            </div>
            {issues.length > 0 && (
              <Alert>
                <AlertDescription>
                  Низкий контраст: {issues.map((i) => `${COLOR_LABELS[i.pair[0]]} / ${COLOR_LABELS[i.pair[1]]} (${i.ratio.toFixed(1)}:1)`).join(', ')}. Рекомендуется ≥ 4.5:1.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Информация и блоки</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {(Object.keys(INFO_LABELS) as Array<keyof typeof INFO_LABELS>).map((k) => (
                <div key={k} className="space-y-1.5">
                  <Label htmlFor={`i-${k}`}>{INFO_LABELS[k]}</Label>
                  <Input id={`i-${k}`} value={info[k]} onChange={(e) => setInfo({ ...info, [k]: e.target.value })} />
                </div>
              ))}
            </div>
            <fieldset className="space-y-3 rounded-lg border p-3" data-testid="settings-channel">
              <legend className="px-1 text-sm font-medium">Telegram-канал магазина</legend>
              <p className="text-xs text-muted-foreground">
                Кнопка под названием магазина на витрине. Без ссылки кнопка не показывается.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="i-channel-label">Название кнопки</Label>
                  <Input
                    id="i-channel-label"
                    value={channelLabel}
                    maxLength={TELEGRAM_CHANNEL_LABEL_MAX}
                    placeholder={DEFAULT_TELEGRAM_CHANNEL_LABEL}
                    onChange={(e) => setChannelLabel(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="i-channel-url">Ссылка на канал</Label>
                  <Input
                    id="i-channel-url"
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://t.me/your_channel"
                    maxLength={200}
                    value={channelUrl}
                    aria-invalid={channelUrlInvalid || undefined}
                    aria-describedby="i-channel-url-hint"
                    onChange={(e) => setInfo({ ...info, telegramChannelUrl: e.target.value })}
                  />
                  <p id="i-channel-url-hint" className={channelUrlInvalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                    {channelUrlInvalid
                      ? 'Нужна ссылка Telegram: https://t.me/канал, @канал или приглашение https://t.me/+…'
                      : 'Публичный канал https://t.me/канал или приватное приглашение https://t.me/+…'}
                  </p>
                </div>
              </div>
            </fieldset>
            <div className="flex flex-wrap gap-4">
              {(Object.keys(SETTINGS_LABELS) as Array<keyof typeof SETTINGS_LABELS>).map((k) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <Switch checked={settings[k]} onCheckedChange={(v) => setSettings({ ...settings, [k]: v })} /> {SETTINGS_LABELS[k]}
                </label>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-legal">Юридическое уведомление</Label>
              <Textarea id="s-legal" value={legal} maxLength={2000} onChange={(e) => setLegal(e.target.value)} />
            </div>
          </CardContent>
        </Card>
        <Button size="lg" disabled={save.isPending} onClick={() => save.mutate()} data-testid="settings-save">
          {save.isPending ? 'Сохраняем…' : 'Сохранить и опубликовать изменения'}
        </Button>
      </div>
      <aside className="space-y-2 lg:sticky lg:top-4 lg:self-start">
        <p className="text-sm font-medium">Предпросмотр</p>
        <ThemePreview theme={theme} name={name} />
      </aside>
    </div>
  );
}
