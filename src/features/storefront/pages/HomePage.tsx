import { ArrowRightIcon, ClockIcon, CreditCardIcon, MapPinIcon, PhoneIcon, TelegramLogoIcon, TruckIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ProductImage } from '@/components/product-image';
import { ErrorState, ProductGridSkeleton, StaleDataNotice } from '@/components/state-views';
import { Button } from '@/components/ui/button';
import { publicImageUrl } from '@/lib/supabase';
import { ProductCard } from '../components/ProductCard';
import { SearchBox } from '../components/SearchBox';
import { ShopLogo } from '../components/ShopLogo';
import { useCategories, useFeatured } from '../hooks';
import { useShop } from '../shop-context';

function InfoRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-3">
      <span aria-hidden className="mt-0.5 text-primary [&_svg]:size-5">
        {icon}
      </span>
      <div>
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="text-sm">{value}</dd>
      </div>
    </div>
  );
}

export function HomePage() {
  const shop = useShop();
  const navigate = useNavigate();
  const categories = useCategories(shop.id);
  const featured = useFeatured(shop.id, shop.settings.showFeatured);
  const cover = publicImageUrl(shop.coverPath);
  const info = shop.info;
  const hasInfo = shop.settings.showInfo && Object.values(info).some(Boolean);

  return (
    <main className="space-y-6 pb-6">
      <header className="relative">
        {cover && <img src={cover} alt="" aria-hidden className="h-36 w-full object-cover sm:h-48" />}
        <div className={cover ? '-mt-8 px-4' : 'px-4 pt-6'}>
          <div className="flex items-end gap-3">
            <ShopLogo name={shop.name} path={shop.logoPath} className="size-16 border-4 border-background" />
            <div className="min-w-0 pb-1">
              <h1 className="truncate text-xl font-bold">{shop.name}</h1>
            </div>
          </div>
          {shop.description && <p className="mt-2 text-sm text-muted-foreground">{shop.description}</p>}
        </div>
      </header>

      <div className="px-4">
        <SearchBox value="" onSubmit={(q) => navigate(`/s/${shop.slug}/catalog${q ? `?q=${encodeURIComponent(q)}` : ''}`)} />
      </div>

      {shop.settings.showCategories && (
        <section aria-labelledby="cats-title" className="space-y-3">
          <h2 id="cats-title" className="px-4 text-lg font-semibold">
            Категории
          </h2>
          {categories.isPending ? (
            <ProductGridSkeleton count={4} />
          ) : categories.isError && !categories.data ? (
            <ErrorState onRetry={() => void categories.refetch()} />
          ) : (
            <ul className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-4">
              {categories.data.map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/s/${shop.slug}/catalog?category=${c.slug}`}
                    className="flex items-center gap-3 rounded-lg border bg-card p-2 pr-3 transition-colors hover:border-primary/60"
                  >
                    <ProductImage path={c.imagePath} alt={c.name} className="size-12 shrink-0 rounded-md" sizes="48px" />
                    <span className="line-clamp-2 text-sm font-medium">{c.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {shop.settings.showFeatured && (featured.isPending || (featured.data?.length ?? 0) > 0 || featured.isError) && (
        <section aria-labelledby="featured-title" className="space-y-3">
          <h2 id="featured-title" className="px-4 text-lg font-semibold">
            Рекомендуем
          </h2>
          {featured.isError && featured.data && <StaleDataNotice onRetry={() => void featured.refetch()} />}
          {featured.isPending ? (
            <ProductGridSkeleton count={4} />
          ) : featured.isError && !featured.data ? (
            <ErrorState onRetry={() => void featured.refetch()} />
          ) : (
            <div className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-3 lg:grid-cols-4">
              {featured.data.map((p) => (
                <ProductCard key={p.id} product={p} slug={shop.slug} currency={shop.currency} />
              ))}
            </div>
          )}
        </section>
      )}

      <div className="px-4">
        <Button asChild size="lg" className="w-full">
          <Link to={`/s/${shop.slug}/catalog`}>
            Весь каталог <ArrowRightIcon aria-hidden />
          </Link>
        </Button>
      </div>

      {hasInfo && (
        <section aria-labelledby="info-title" className="mx-4 space-y-3 rounded-lg border bg-card p-4">
          <h2 id="info-title" className="font-semibold">
            О магазине
          </h2>
          <dl className="space-y-3">
            <InfoRow icon={<MapPinIcon />} label="Адрес" value={info.address} />
            <InfoRow icon={<ClockIcon />} label="Часы работы" value={info.hours} />
            <InfoRow icon={<TruckIcon />} label="Получение" value={info.delivery} />
            <InfoRow icon={<CreditCardIcon />} label="Оплата" value={info.payment} />
            <InfoRow icon={<PhoneIcon />} label="Телефон" value={info.phone} />
            <InfoRow icon={<TelegramLogoIcon />} label="Telegram" value={info.telegram} />
          </dl>
        </section>
      )}

      {shop.legalNotice && <p className="px-4 text-xs text-muted-foreground">{shop.legalNotice}</p>}
    </main>
  );
}
