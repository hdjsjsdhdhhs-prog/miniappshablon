import { expect, test, type Page } from '@playwright/test';

// Product page composition on mobile: (DEMO banner) → photo directly under it → "Назад" floating over the top of the
// photo. Checked in DEMO shops (noir-vapor dark, mint-lab light) and a regular live shop (neon-district).
const SHOPS = [
  { slug: 'noir-vapor', demo: true },
  { slug: 'mint-lab', demo: true },
  { slug: 'neon-district', demo: false },
] as const;
const WIDTHS = [320, 375, 390, 430];

async function openFirstProductFromCatalog(page: Page, slug: string) {
  await page.goto(`/s/${slug}/`);
  await page.getByTestId('product-card').first().getByTestId('product-card-link').click();
  await expect(page).toHaveURL(new RegExp(`/s/${slug}/product/`));
  await expect(page.getByTestId('product-back')).toBeVisible();
}

/** Geometry + colours measured in the page. Colours are resolved through a canvas, so any CSS colour syntax works. */
function measure(page: Page) {
  return page.evaluate(() => {
    const q = (s: string) => document.querySelector<HTMLElement>(`[data-testid="${s}"]`);
    const banner = q('demo-banner');
    const media = q('product-media')!;
    const back = q('product-back')!;
    const r = (el: Element) => el.getBoundingClientRect();
    const rgba = (css: string) => {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [R, G, B, A] = ctx.getImageData(0, 0, 1, 1).data;
      return { r: R!, g: G!, b: B!, a: A! / 255 };
    };
    const lum = ({ r: R, g: G, b: B }: { r: number; g: number; b: number }) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(R) + 0.7152 * f(G) + 0.0722 * f(B);
    };
    const cs = getComputedStyle(back);
    const bg = rgba(cs.backgroundColor);
    const fg = rgba(cs.color);
    const [l1, l2] = [lum(bg), lum(fg)].sort((a, b) => b - a);
    const m = r(media);
    const b = r(back);
    // What is painted just above the button, inside the top 12 px of the media block: must be the photo itself.
    const probe = document.elementFromPoint(b.left + b.width / 2, m.top + 4);
    return {
      bannerBottom: banner ? r(banner).bottom : null,
      mediaTop: m.top,
      mediaLeft: m.left,
      mediaWidth: m.width,
      mediaHeight: m.height,
      backTop: b.top,
      backLeft: b.left,
      backHeight: b.height,
      backWidth: b.width,
      bgAlpha: bg.a,
      contrast: (l1! + 0.05) / (l2! + 0.05),
      probeInMedia: !!probe && media.contains(probe) && !back.contains(probe),
      mainFirstIsMedia: document.querySelector('main')?.firstElementChild === media,
      hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

for (const shop of SHOPS) {
  test(`${shop.slug}${shop.demo ? ' (DEMO)' : ''}: photo right under the banner, "Назад" over the photo at 320–430 px`, async ({ page }, info) => {
    await openFirstProductFromCatalog(page, shop.slug);
    if (shop.demo) await expect(page.getByTestId('demo-banner')).toBeVisible();
    else await expect(page.getByTestId('demo-banner')).toHaveCount(0);

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => window.scrollTo(0, 0));
      const m = await measure(page);
      const at = `${shop.slug} @ ${width}px`;
      // 1. No strip: the photo starts exactly where the banner ends (or at the very top without a banner).
      expect(m.mainFirstIsMedia, at).toBe(true);
      expect(Math.abs(m.mediaTop - (m.bannerBottom ?? 0)), at).toBeLessThanOrEqual(1);
      expect(m.probeInMedia, at).toBe(true);
      // 2. The photo keeps its square format across the full width.
      expect(Math.abs(m.mediaHeight - m.mediaWidth), at).toBeLessThanOrEqual(1);
      // 3. The button sits on the photo's top edge with the old 12 px / 16 px offsets and the old 40 px pill.
      expect(m.backTop - m.mediaTop, at).toBeCloseTo(12, 0);
      expect(m.backLeft - m.mediaLeft, at).toBeCloseTo(16, 0);
      expect(m.backHeight, at).toBeCloseTo(40, 0);
      expect(m.backWidth, at).toBeGreaterThan(70);
      expect(m.backWidth, at).toBeLessThan(110);
      // 4. Readable on any photo: near-opaque own fill and WCAG AA text contrast against it.
      expect(m.bgAlpha, at).toBeGreaterThanOrEqual(0.9);
      expect(m.contrast, at).toBeGreaterThanOrEqual(4.5);
      expect(m.hScroll, at).toBeLessThanOrEqual(0);
      await page.screenshot({ path: info.outputPath(`product-${shop.slug}-${width}.png`) });
    }

    // 5. Real navigation: back to the catalog entry it came from.
    await page.getByTestId('product-back').click();
    await expect(page).toHaveURL(new RegExp(`/s/${shop.slug}/$`));
    await expect(page.getByTestId('product-card').first()).toBeVisible();
  });
}

test('direct link: "Назад" opens the shop catalog; browser history stays consistent', async ({ page }) => {
  await openFirstProductFromCatalog(page, 'neon-district');
  const productUrl = page.url();
  // Fresh tab with only the product URL in its history.
  const direct = await page.context().newPage();
  await direct.goto(productUrl);
  await direct.getByTestId('product-back').click();
  await expect(direct).toHaveURL(/\/s\/neon-district\/$/);
  // replace: the browser's own back button does not bounce into the product page again.
  await direct.goBack().catch(() => null);
  expect(direct.url()).not.toBe(productUrl);
  await direct.close();

  // In-app: catalog → product → back → browser forward returns to the same product.
  await page.getByTestId('product-back').click();
  await expect(page).toHaveURL(/\/s\/neon-district\/$/);
  await page.goForward();
  await expect(page).toHaveURL(productUrl);
  await expect(page.getByTestId('product-media')).toBeVisible();
});
