# Универсальная витрина вейп-шопов в Telegram Mini App

Один репозиторий, **один frontend-билд**, **один Supabase-проект** и сколько угодно независимых магазинов (tenants).
Новый магазин описывается файлом `tenants/<slug>/shop.config.json` и картинками. Pipeline переносит их в Supabase,
дальше владелец всё меняет в веб-админке, без правки исходников и без нового деплоя.

Основной источник требований: [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md). Настройка окружения описана в [`SETUP.md`](SETUP.md),
подключение магазина в [`CLONE-IN-6-MINUTES.md`](CLONE-IN-6-MINUTES.md), выполненные проверки в [`ACCEPTANCE.md`](ACCEPTANCE.md).

## Возможности

| Витрина (`/s/:slug/…`) | Админка (`/admin`) |
| --- | --- |
| Главная: логотип, обложка, описание, поиск, категории, рекомендуемое, блок «О магазине» | Вход через Supabase Auth (email/пароль), публичной регистрации нет |
| Каталог: категории-чипсы, поиск по названию, серверная пагинация | Обзор: реальные счётчики заказов и закончившиеся варианты |
| Карточка: галерея, выбор вкуса/цвета, цена и остаток выбранного варианта | Товары: CRUD, архив вместо удаления, варианты (вкус/цвет/SKU/цена/остаток) |
| Корзина отдельно для каждого магазина, оформление заказа без онлайн-оплаты | Фото: сжатие в WebP, загрузка, замена и удаление одного фото, выбор главного, порядок |
| Профиль: только собственные заказы покупателя, по проверенной Telegram-идентичности | Категории: создание, переименование, порядок, видимость, изображение, архив |
| Нижняя навигация: Каталог / Корзина (счётчик) / Профиль; Telegram Back, safe area | Заказы: фильтры, допустимые переходы статусов, отмена с возвратом остатка |
| Подтверждение возраста, плашка DEMO/Preview | Оформление: название, описание, логотип, обложка, 11 цветов, радиус, блоки, контакты, предпросмотр и проверка контраста |

## Архитектура

```text
tenants/<slug>/shop.config.json + assets/   ─(pnpm tenant:seed)→   Supabase (runtime-источник истины)
                                                                    ├─ Postgres + RLS (shop_id везде, составные FK)
Browser / Telegram WebView                                          ├─ Storage: shop-media/<shop_id>/…
 ├─ /s/:slug  → anon-ключ + RLS (только опубликованный каталог)      ├─ Edge Functions: checkout, my-orders
 │            → Edge Functions + X-Telegram-Init-Data (заказы)      │     (проверяют initData → service_role → RPC)
 └─ /admin    → Supabase Auth JWT + RLS + SECURITY DEFINER RPC      └─ RPC: create_order (атомарно), admin_set_*
```

* **Изоляция tenants.** Везде `shop_id`, составные FK `(shop_id, id)`, политики RLS через `is_shop_member()`,
  Storage-политики по первому сегменту пути. Ключи TanStack Query начинаются с id магазина, корзина хранится под ключом магазина.
* **Покупатель.** Личность подтверждается только на сервере: HMAC-SHA256 `initData` по [официальному алгоритму](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
  с ограничением возраста `auth_date`. `initDataUnsafe` и `user.id` из тела запроса не используются.
* **Заказ.** `create_order` выполняется одной транзакцией: блокирует строки вариантов `FOR UPDATE` в порядке id,
  берёт текущую цену и остаток из БД, списывает остаток, записывает snapshot строк заказа и журнал `inventory_movements`.
  Идемпотентность: advisory-lock плюс `UNIQUE (shop_id, customer_tg_id, idempotency_key)` и хэш запроса.
  Отмена возвращает остаток не более одного раза (уникальный `operation_key` в журнале).
* **Владелец.** Пишет напрямую только разрешённые колонки (column-level GRANT). Остатки и статусы меняются только через RPC
  с проверкой членства. Удаления товаров нет, только архив.
* **Секреты.** `service_role` и Telegram Bot Token существуют только в Edge Functions и в shell оператора.
  `pnpm check:bundle-secrets` проверяет собранный бандл, source maps не публикуются.

## Стек

TypeScript strict · React 19 · Vite 8 · React Router 8 · pnpm · `@tma.js/sdk-react` 3 · Tailwind CSS v4 · shadcn/ui
(иконки Phosphor вместо lucide) · TanStack Query v5 · React Hook Form + Zod 4 · Supabase (Postgres/Auth/Storage/RLS/Edge Functions,
CLI-миграции) · browser-image-compression · Vitest · React Testing Library · Playwright · ESLint · GitHub Actions ·
Vercel и Cloudflare Pages (SPA fallback уже настроен).

Отклонения от плана, все обоснованы:
* **TypeScript 6.0**, а не 7.0: `typescript-eslint` 8.x поддерживает `<6.1`.
* **Vitest 4.1**, а не 5.0.4: в этом окружении (Windows) 5.0.4 падает даже на тривиальном тесте с ошибкой
  «failed to find the current suite».
* **Astryx не установлен**, поэтому используются Tailwind v4 и shadcn/ui.
* **ui-ux-pro-max** предложил стиль «Liquid Glass» и шрифт Cormorant. Стекло отклонено (план запрещает избыточный glass,
  к тому же это нагрузка на WebView), внешний шрифт тоже (лишний сетевой запрос в WebView). Взяты тёмная палитра с золотым
  акцентом, чек-листы контраста, фокуса, safe area и reduced-motion.

## Быстрый старт (локально)

```bash
pnpm install
pnpm db:start                       # локальный Supabase в Docker + все миграции
pnpm tenant:seed --slug noir-vapor  # demo-tenant 1 (тёмный премиальный)
pnpm tenant:seed --slug mint-lab    # demo-tenant 2 (светлый минималистичный)
OWNER_PASSWORD=local-demo-owner-pass pnpm owner:add --slug noir-vapor --email owner@noir-vapor.local
pnpm tenant:publish --slug noir-vapor --yes
pnpm dev:local                      # http://127.0.0.1:5173/s/noir-vapor/  и  /admin
```

`pnpm dev:local` передаёт в Vite URL и anon-ключ локального стека через переменные процесса, `.env`-файлы не нужны.

## Команды

| Команда | Назначение |
| --- | --- |
| `pnpm tenant:new --slug <slug> [--name ...] [--force]` | шаблон `tenants/<slug>/`; существующий tenant без `--force` не перезаписывается |
| `pnpm tenant:validate --slug <slug>` | Zod-схема, slug, цвета и контраст, ссылки, файлы изображений (формат, размер, разрешение), поиск секретов |
| `pnpm tenant:seed --slug <slug>` | идемпотентный импорт: вставляет только отсутствующие `seed_key`, правки владельца не трогает |
| `pnpm tenant:publish --slug <slug> --yes [--unpublish]` | preview → live после проверок (legal notice, 18+, категории, товары в наличии, владелец) |
| `pnpm tenant:verify --slug <slug> [--app-url URL] [--strict]` | публичный каталог через anon, отсутствие приватных данных для anon, владелец, картинки, Telegram-ссылка, глубокие ссылки |
| `pnpm owner:add --slug <slug> --email <e>` / `--platform-admin` | выдать доступ владельцу или администратору платформы |
| `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build` · `pnpm check:bundle-secrets` · `pnpm check:tenant-names` | качество |
| `pnpm test:integration` · `pnpm test:e2e` | SQL/RLS/Storage/конкурентность против локального Supabase · Playwright |

Коды выхода: `0` успех, `1` проверка не пройдена, `2` ошибка использования или окружения.

## Структура

```text
src/domain/          чистая логика: тема, конфиг tenant, цены, варианты, статусы, ключи кэша, seed-план (+ unit-тесты)
src/features/        storefront/ cart/ telegram/ theme/ admin/   (страницы и компоненты по фичам)
src/components/ui/   shadcn/ui
supabase/migrations/ схема, RLS, GRANT, RPC, Storage (воспроизводимо: `supabase db diff` = пусто)
supabase/functions/  checkout, my-orders, _shared (проверка initData не зависит от рантайма)
tenants/             demo-конфиги и изображения (синтетические демо-иллюстрации, не фото товаров)
scripts/             tenant pipeline, owner:add, проверки
tests/integration/   RLS, Storage, checkout/конкурентность/идемпотентность, snapshot, seed
e2e/                 Playwright: заказ → админка → остаток → изоляция; брендинг без деплоя
```
