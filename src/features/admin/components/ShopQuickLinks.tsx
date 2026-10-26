import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SHOP_SECTIONS, storefrontPath } from '../shop-search';

export function ShopModeBadge({ mode }: { mode: string }) {
  return <Badge variant={mode === 'live' ? 'default' : 'secondary'}>{mode === 'live' ? 'live' : 'preview'}</Badge>;
}

/** Compact row of links into one shop's admin sections plus its public storefront. */
export function ShopQuickLinks({ slug }: { slug: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button asChild size="sm">
        <Link to={`/admin/shops/${slug}`}>Управление</Link>
      </Button>
      {SHOP_SECTIONS.map((s) => (
        <Button key={s.to} asChild size="sm" variant="outline">
          <Link to={`/admin/shops/${slug}/${s.to}`}>{s.label}</Link>
        </Button>
      ))}
      <Button asChild size="sm" variant="ghost">
        <a href={storefrontPath(slug)} target="_blank" rel="noreferrer">
          Витрина <ArrowSquareOutIcon aria-hidden />
        </a>
      </Button>
    </div>
  );
}
