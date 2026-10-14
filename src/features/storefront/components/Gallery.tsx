import { useRef, useState } from 'react';
import { ProductImage } from '@/components/product-image';
import { cn } from '@/lib/utils';
import type { ProductImage as Img } from '../api';

/** Swipeable gallery using native scroll-snap (no extra library). */
export function Gallery({ images, name }: { images: Img[]; name: string }) {
  const [index, setIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  if (images.length === 0) return <ProductImage path={null} alt={name} className="w-full" />;

  const goTo = (i: number) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ left: el.clientWidth * i, behavior: 'smooth' });
  };

  return (
    <div className="relative">
      <div
        ref={ref}
        className="scrollbar-none flex snap-x snap-mandatory overflow-x-auto"
        aria-roledescription="галерея"
        aria-label={`Фото: ${name}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          setIndex(Math.round(el.scrollLeft / Math.max(el.clientWidth, 1)));
        }}
      >
        {images.map((img, i) => (
          <div key={img.id} className="w-full shrink-0 snap-center" aria-label={`${i + 1} из ${images.length}`}>
            <ProductImage path={img.storage_path} alt={img.alt_text || name} eager={i === 0} sizes="100vw" />
          </div>
        ))}
      </div>
      {images.length > 1 && (
        <div className="absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
          {images.map((img, i) => (
            <button
              key={img.id}
              type="button"
              aria-label={`Показать фото ${i + 1}`}
              aria-current={i === index}
              onClick={() => goTo(i)}
              className="flex size-6 items-center justify-center"
            >
              <span className={cn('block size-2 rounded-full bg-foreground/40', i === index && 'bg-primary')} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
