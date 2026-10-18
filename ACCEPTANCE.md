# ACCEPTANCE: фактически выполненные проверки

Окружение: Windows, Node 22.23, pnpm 10.33, Docker 29.4, локальный Supabase (CLI 2.120, Postgres 17) с миграциями из
`supabase/migrations/`. Дата прогона: 14.10.2026. Ниже только проверки, которые реально запускались, с наблюдённым результатом.

## Результаты

| # | Проверка | Команда | Результат |
| --- | --- | --- | --- |
| 1 | ESLint | `pnpm lint` | ✅ 0 ошибок, 0 предупреждений |
| 2 | TypeScript strict (app, тесты, scripts/e2e) | `pnpm typecheck` | ✅ без ошибок |
| 3 | Unit + RTL | `pnpm test` | ✅ 9 файлов, **47 тестов** |
| 4 | Сборка | `pnpm build` (VITE_* = placeholders) | ✅ основной чанк 969 КБ (284 КБ gzip), админка отдельным чанком 190 КБ |
| 5 | Секреты в бандле | `pnpm check:bundle-secrets` | ✅ не найдено, source maps не публикуются |
| 6 | Названия tenants не зашиты в `src/` | `pnpm check:tenant-names` | ✅ |
| 7 | Валидация tenants | `pnpm tenant:validate --slug noir-vapor` / `mint-lab` | ✅ exit 0 (предупреждения: нет фото у одного товара; не задан бот) |
| 8 | Идемпотентный seed | `tenant:seed` ×2 на оба tenant | ✅ 2-й прогон: «+0 категорий, +0 товаров, +0 вариантов» |
| 9 | Публикация с проверками | `tenant:publish` без `--yes` и без владельца | ✅ отказ, exit ≠ 0; после `owner:add` публикация проходит |
| 10 | Пост-проверка | `tenant:verify --slug noir-vapor` / `mint-lab` | ✅ exit 0 |
| 11 | `tenant:new` | создать, повторить без `--force`, плохой slug | ✅ создан; повтор отклонён; `Bad_Slug` отклонён |
| 12 | Воспроизводимость миграций | `supabase db diff --local` (чистая shadow-БД из 6 миграций) | ✅ «No schema changes found» |
| 13 | SQL/integration | `pnpm test:integration` | ✅ 4 файла, **30 тестов**; checkout-сьют повторён 3× подряд, все прогоны зелёные |
| 14 | Playwright E2E (Pixel 7, Chromium) | `pnpm test:e2e` | ✅ **2 сценария** |

### Что покрывают integration-тесты (`tests/integration/`)

* **RLS и изоляция:** anon видит только live-магазины, опубликованные товары, активные варианты и категории; anon не читает
  `orders`, `order_items`, `shop_memberships`, `inventory_movements`, `platform_admins`, `shop_order_counters`; anon не
  пишет и не вызывает `create_order` / `admin_set_variant_stock`. Владелец A меняет только A; не читает заказы, членства и журнал B;
  не вставляет в B; составной FK не даёт связать товар A с категорией B, а вариант A с товаром B. Прямой `UPDATE` остатка,
  `mode`/`is_demo`, статуса заказа и `DELETE` товара запрещены на уровне GRANT. RPC владельца A отвергают объекты B.
  Тема валидируется на сервере.
* **Storage:** загрузка в свою папку разрешена и файл публично читается; в чужую папку нельзя загрузить, перезаписать,
  удалить или прочитать список; anon не загружает и не видит список; путь вне папки магазина и не-image MIME отклоняются;
  в БД нельзя сослаться на файл чужого магазина.
* **Checkout:** цена берётся из БД, snapshot сохраняется, остаток списывается; несовпадение суммы с клиента даёт `price_changed`
  без создания заказа. **Идемпотентность:** повтор возвращает тот же заказ и списывает остаток один раз; тот же ключ с другим телом
  даёт 422; 5 параллельных одинаковых запросов создают 1 заказ. **Конкурентность:** 10 покупателей на последнюю единицу дают
  ровно 1×201 и 9×409, остаток 0. **История цены:** после смены цены, имени и вкуса старый заказ не меняется. Чужой, неактивный
  или неопубликованный вариант даёт `item_unavailable`; количество 0, 100 и 1.5 отклоняется; несовпадение валюты и превышение
  остатка отклоняются. Preview даёт 403 без записи; demo-заказы получают `is_test=true`.
  Отсутствующий, подделанный (`user.id`), подписанный другим ботом и просроченный initData дают 401.
  `userId` в теле запроса игнорируется.
* **Отмена:** недопустимый переход отклоняется; 4 параллельные отмены возвращают остаток ровно один раз
  (1 запись `cancel_restore`).
* **Мои заказы:** покупатель видит только свои; другой Telegram ID не получает чужой заказ даже по `orderId`; другой магазин даёт пусто.
* **Варианты и seed:** уникальность сочетания вкус/цвет, остаток не уходит ниже нуля; повторный `tenant:seed` (реальный запуск CLI)
  не создаёт дубликатов и сохраняет правки владельца (имя, цена товара, имя магазина).

### E2E (`e2e/`)

1. `order-flow.spec.ts`: открыть demo `noir-vapor` с Telegram launch params → подтвердить 18+ → категория «Жидкости» →
   товар → вкус «Черника» (своя цена 740 ₽ и свой остаток) → корзина → оформление через Edge Function → в БД заказ
   `is_test`, snapshot цены 74000 и списание остатка → «Мои заказы» → владелец входит в `/admin`, видит заказ →
   меняет остаток варианта на 42 → витрина показывает «В наличии: 42 шт.» → владелец `mint-lab` не видит магазин
   («Нет доступа»), не читает заказ и не меняет товар или остаток через API.
2. `owner-branding.spec.ts`: владелец меняет название и основной цвет и загружает логотип (browser-image-compression → WebP →
   Storage) → витрина показывает новое имя, логотип и `--primary` без пересборки.

## Найдено и исправлено тестами

* **Гонка в `create_order`.** Под нагрузкой 3 из 10 запросов получали 500: остаток читался из снимка, сделанного до ожидания
  `FOR UPDATE`. Перепродажи не было (её остановил CHECK `stock >= 0`), но покупатели видели 500. Исправлено миграцией
  `20261014090400_fix_create_order_locking.sql`: значения берутся из заблокированной строки, списание дополнительно
  защищено условием.
* **`is_valid_theme()` пропускал неполную тему.** `NULL`-сравнение в PL/pgSQL. Исправлено миграцией
  `20261014090500_fix_theme_validation_nulls.sql`.

## Отклонения и решения

* TypeScript 6.0 (а не 7): ограничение peer-зависимости `typescript-eslint`.
* Vitest 4.1.11 (а не 5.0.4): 5.0.4 в этом окружении падает на тривиальном тесте («failed to find the current suite»).
* Astryx не установлен, поэтому Tailwind v4 + shadcn/ui; иконки lucide заменены на Phosphor, `next-themes` и пакет `cn` удалены.
* ui-ux-pro-max: Liquid Glass и шрифт Cormorant отклонены (план и производительность WebView), использованы палитра и UX-чек-листы.
* Storage-бакет `shop-media` публичный на чтение: в нём только изображения витрины, имена UUID, список файлов закрыт политиками.
  Файлы preview-магазина доступны по прямому URL, если его знать.
* Основной JS-чанк 284 КБ gzip (react-dom, supabase-js, tma.js SDK, zod, react-router). Дальнейшая оптимизация не проводилась.

## НЕ выполнено или не подтверждено (внешние зависимости)

| Пункт | Причина | Что нужно |
| --- | --- | --- |
| Запуск в **настоящем Telegram-клиенте**, BotFather, deep link `t.me/...?startapp=` | нет бота и токена; E2E эмулирует только клиентский мост (`TelegramWebviewProxy`) и передаёт launch params в hash, initData подписан **локальным тестовым токеном** | создать бота, `supabase secrets set TELEGRAM_BOT_TOKEN`, проверить на телефоне |
| **Hosted Supabase** (`functions deploy`, secrets, tenant seed/publish, облачный заказ) | 6 миграций применены 17.10.2026 (см. «Применение миграций»), исправление прав `20261017090000_harden_function_privileges.sql` применено 18.10.2026 (см. «Применение исправления прав на hosted — 18.10.2026»); Edge Functions `checkout`/`my-orders` не развёрнуты, `TELEGRAM_BOT_TOKEN` и `ALLOWED_ORIGINS` не заданы, tenants нет; роль `authenticated` через HTTP не проверена; пробный заказ не выполнялся | `secrets set TELEGRAM_BOT_TOKEN` и `ALLOWED_ORIGINS`, `functions deploy`, seed/publish тестового магазина, затем HTTP-проверка `authenticated` и пробный заказ с фиктивными данными |
| **Деплой frontend** (Vercel / Cloudflare Pages) и проверка публичной ссылки | Vercel CLI не установлен, логина и токенов нет; Vercel MCP недоступен | вход владельца, проект Vercel или Cloudflare, переменные `VITE_*`; затем `tenant:verify --app-url` |
| GitHub Actions: деплой на Cloudflare Pages и `supabase-deploy.yml` | CI на раннере проходит (см. «Прогон 17.10.2026»), но job деплоя пропускается: не заданы `vars.CLOUDFLARE_PAGES_PROJECT` и секреты Cloudflare; ручной `supabase-deploy.yml` не запускался (нет секретов Supabase) | переменные и секреты в настройках репозитория |
| Ручная визуальная проверка на устройствах, скринридер, landscape | не проводилась; автоматически проверены роли и подписи (RTL/Playwright) и контраст палитр | ручной прогон |
| Коммерческая эксплуатация на бесплатных тарифах | Vercel Hobby только некоммерческий; Supabase Free ставит проект на паузу и не делает бэкапы | выбор тарифа владельцем |

## Прогон 17.10.2026: канал Telegram, быстрое добавление в корзину, плавающая навигация

Окружение то же (Windows, локальный Supabase). Что изменилось:

* **Кнопка Telegram-канала магазина** (`shops.info.telegramChannelUrl` / `telegramChannelLabel`). Владелец задаёт её в админке
  («Оформление»), на витрине кнопка стоит под названием магазина. Ссылка проходит через `normalizeTelegramChannelUrl`
  (`src/domain/telegram-link.ts`) и сохраняется только как `https://t.me/<канал>` или `https://t.me/+<приглашение>`;
  `@канал`, `t.me/...` и `telegram.me/...` приводятся к этому виду, `javascript:`, `tg:`, чужие хосты и порты отклоняются.
  Проверка есть в zod-схеме tenant, в админке перед сохранением и на витрине перед выводом. Внутри Telegram ссылка
  открывается через `openTelegramLink`, в обычном браузере — как `<a target="_blank" rel="noopener noreferrer">`. Старые конфиги
  без этих полей остаются валидными (по умолчанию `''`).
* **«В корзину» на карточке каталога** открывает нижнюю шторку `QuickAddSheet` (Radix Dialog): в ней только доступные вкусы
  и только существующие сочетания вкус × цвет, ничего не выбрано заранее. Перед добавлением остаток перечитывается; если вариант
  закончился, шторка показывает ошибку и кнопку «Обновить». Повторное добавление того же варианта объединяется в одну строку
  корзины. Ссылка и кнопка карточки — соседние элементы, не вложенные друг в друга.
* **Плавающая нижняя навигация.** Одна общая подсветка выбранного пункта следует за `aria-current` роутера. Пока открыта
  экранная клавиатура, навигация скрывается (`inert`). `--safe-bottom` учитывает `--tg-viewport-safe-area-inset-bottom`.
* На главной убран видимый заголовок «Категории»; у списка плиток осталось доступное имя.

| # | Проверка | Команда | Результат |
| --- | --- | --- | --- |
| 1 | ESLint | `pnpm lint` | ✅ 0 ошибок, 0 предупреждений |
| 2 | TypeScript strict | `pnpm typecheck` | ✅ без ошибок |
| 3 | Unit + RTL | `pnpm test` | ✅ 12 файлов, **92 теста** (было 9 / 47) |
| 4 | Сборка | `pnpm build` (VITE_* = placeholders) | ✅ основной чанк 984 КБ (289 КБ gzip), админка 190 КБ |
| 5 | Секреты в бандле | `pnpm check:bundle-secrets` | ✅ не найдено |
| 6 | Названия tenants не зашиты в `src/` | `pnpm check:tenant-names` | ✅ |
| 7 | Валидация tenants | `pnpm tenant:validate --slug noir-vapor` / `mint-lab` | ✅ exit 0 (те же предупреждения) |
| 8 | SQL/integration | `pnpm test:integration` | ✅ 4 файла, **30 тестов** |
| 9 | Playwright E2E | `pnpm test:e2e` | ✅ **16 сценариев** (новые: `quick-add.spec.ts` ×5, `telegram-channel.spec.ts` ×2) |

Новые unit-тесты: `telegram-link.test.ts` (допустимые и опасные ссылки), `QuickAddSheet.test.tsx` (фильтрация вариантов,
объединение строк, отказ при закончившемся остатке, товар без опций), а также дополнения к `tenant-config`, `BottomNav` и `HomePage`.

**Найдено при прогоне.** `telegram-channel.spec.ts` падал на проверке изоляции: в локальной БД у `noir-vapor` уже была
задана ссылка на канал (её ввели вручную, в `tenants/` её нет), а тест считал, что у второго магазина канала нет. Код витрины
ошибки не содержит. Исправлено предусловие теста: `beforeAll` очищает канал у `noir-vapor`, `afterAll` возвращает исходные
`info` обоих магазинов (после прогона проверено в БД). Каталог `.tmp-shots/` (скриншоты и временные скрипты) добавлен в `.gitignore`.

**GitHub Actions (CI, `ubuntu-latest`).** Прогоны #1–#5 падали на шаге `Migrations reproduce the schema` из-за ошибки в самом
workflow: `supabase db diff` пишет «No schema changes found» в stderr, а шаг перехватывал только stdout, поэтому `grep` не
находил фразу. Локально в bash с тем же Supabase CLI 2.120.0 старая команда давала exit 1, исправленная (`2>&1 | tee`) — exit 0.
После исправления (`85ebe26`) run #6 зелёный
([39069907972](https://github.com/hdjsjsdhdhhs-prog/miniappshablon/actions/runs/39069907972)): job «Lint · types · unit · build»
и job «SQL/integration + Playwright» прошли все шаги, включая `db diff`, seed/publish/verify обоих tenants,
`test:integration` и `test:e2e`. Job «Deploy frontend to Cloudflare Pages» пропущен: не задан `CLOUDFLARE_PAGES_PROJECT`.
Логи раннера без токена GitHub недоступны (403), поэтому число тестов на раннере не приводится — только статусы шагов из API.

**Не проверено:** работа кнопки канала через `openTelegramLink` в настоящем Telegram-клиенте и поведение навигации при открытой
экранной клавиатуре на реальных Android/iOS. Скрытие навигации при открытой клавиатуре автотестами не покрыто.

## Диагностика hosted Supabase 17.10.2026 (`xcbugcjmddtubytpvffa`)

Состояние **на момент диагностики, до `db push`**: миграции не применены, деплоя нет. Ниже только наблюдённые тогда факты;
текущее состояние см. в разделах «Применение миграций» и «Применение исправления прав на hosted — 18.10.2026».

| Проверка | Результат |
| --- | --- |
| Supabase MCP в сессии агента | ❌ недоступен (в наборе инструментов сессии нет ни одного Supabase-инструмента) |
| `pnpm exec supabase projects list` (CLI 2.120.0) | ❌ `AccessTokenRequiredError`; `supabase/.temp/project-ref` отсутствует (проект не привязан) |
| Переменные `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN` в shell | не заданы |
| Бандл `https://miniappdemo.pages.dev/assets/index-CK1xbvHn.js` | ✅ единственный Supabase URL: `https://xcbugcjmddtubytpvffa.supabase.co`, ключ формата `sb_publishable_*` |
| `GET /rest/v1/shops` и `/rest/v1/products` (publishable key) | ❌ 404 `PGRST205` «Could not find the table 'public.shops'» |
| `GET /storage/v1/bucket/shop-media` | ❌ `NoSuchBucket` |
| `OPTIONS /functions/v1/checkout` | ❌ 404 «Requested function was not found» |
| `https://miniappdemo.pages.dev/s/noir-vapor/` | HTML отдаётся (200), данные не загружаются: схемы нет |

**Причина ошибки витрины:** frontend указывает на правильный проект, но в нём не применены 6 миграций из `supabase/migrations/`,
нет бакета `shop-media`, не задеплоены Edge Functions и нет tenant `noir-vapor`. История миграций удалённой БД не проверена:
без доступа к БД/Management API её не прочитать.

## Применение миграций в hosted Supabase 17.10.2026 (`xcbugcjmddtubytpvffa`)

Выполнено после подтверждения владельца. Edge Functions, секреты, tenant seed/publish **не запускались**.

| Проверка | Команда | Результат |
| --- | --- | --- |
| Привязка проекта | сравнение `supabase/.temp/project-ref` с `xcbugcjmddtubytpvffa` (до dry-run и повторно перед push) | ✅ `PROJECT_REF_MATCH` |
| Предварительная проверка | `pnpm exec supabase db push --dry-run` | ✅ exit 0, к отправке 6 миграций, seeds/roles нет |
| Применение | `pnpm exec supabase db push --yes` | ✅ exit 0, применены все 6 миграций, ошибок нет |
| История миграций | `pnpm exec supabase migration list` | ✅ у всех 6 версий `local` = `remote` |
| Таблицы `public` | `supabase db dump --linked --schema public` | ✅ 11 из 11: `shops`, `platform_admins`, `shop_memberships`, `categories`, `products`, `product_variants`, `product_images`, `orders`, `order_items`, `shop_order_counters`, `inventory_movements`; RLS включён на 11 |
| Функции, триггеры, индексы | тот же дамп | ✅ 14/14 функций, 5/5 триггеров `*_updated_at`, 14/14 индексов |
| Политики RLS `public` | тот же дамп | ✅ 25, совпадает с 25 `create policy` на `public.*` в миграциях |
| Бакет Storage | `supabase storage ls ss:/// --linked --experimental` | ✅ `shop-media/` |
| Совпадение схемы с миграциями | `supabase db diff --linked --schema public,storage` | ⚠️ таблицы, функции и политики совпадают, **привилегии нет** (ниже) |

**Расхождение привилегий (на момент этой проверки не исправлено; исправлено 18.10.2026, см. «Применение исправления прав на hosted — 18.10.2026»).** В миграциях `create_order`, `get_customer_orders`, `order_to_json`,
`admin_set_order_status`, `admin_set_variant_stock` и др. закрыты только через `REVOKE … FROM public`. На hosted-проекте
default privileges схемы `public` отдельно выдают `EXECUTE` ролям `anon` и `authenticated`, поэтому в дампе удалённой БД есть
`GRANT ALL ON FUNCTION public.create_order(…) TO anon` (то же для `get_customer_orders`, `order_to_json`, `admin_set_*`).
`create_order` и `get_customer_orders` — `SECURITY DEFINER`, поэтому по publishable key их можно вызвать напрямую через
`/rest/v1/rpc/…` в обход проверки initData в Edge Function. В локальной shadow-БД этих GRANT нет, поэтому integration-тесты
«anon не вызывает `create_order`» проходили. Права на таблицы совпадают (`revoke all on all tables` в `access_control.sql`).
Прямой вызов RPC от `anon` на hosted не проверялся. Что нужно: новая миграция с явным `REVOKE EXECUTE … FROM anon, authenticated`
(и `ALTER DEFAULT PRIVILEGES` для схемы `public`) до деплоя Edge Functions и seed/publish.

## Исправление прав EXECUTE 17.10.2026: разработка и локальная проверка

Миграция `supabase/migrations/20261017090000_harden_function_privileges.sql` 17.10.2026 была сначала применена только к
локальному Supabase (`supabase migration up --local`, без `db reset`). 18.10.2026 она применена к hosted-проекту
`xcbugcjmddtubytpvffa`; результаты проверки на hosted см. в разделе «Применение исправления прав на hosted — 18.10.2026».

**Причина.** Миграции применяет роль `postgres` (владелец всех 14 функций и локально, и на hosted). На hosted действует
`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS/TABLES/SEQUENCES TO anon, authenticated, service_role`,
а `revoke … from public` прямые права ролей не снимает. Локально `auto_expose_new_tables = false` в `supabase/config.toml`
убирает эти defaults, поэтому локальная БД и тесты баг не воспроизводили.

**Allowlist EXECUTE после миграции** (владелец `postgres` сохраняет права; `PUBLIC` не получает ничего):

| Функция | anon | authenticated | service_role | Кто вызывает |
| --- | --- | --- | --- | --- |
| `shop_is_public`, `product_is_public` | ✅ | ✅ | ✅ | публичные RLS-политики витрины |
| `is_shop_member` | — | ✅ | ✅ | админка (`fetchAdminShop`), RLS и Storage-политики |
| `is_platform_admin`, `storage_object_shop_id` | — | ✅ | ✅ | RLS-политики `memberships_self_read`, Storage-политики |
| `admin_set_order_status`, `admin_set_variant_stock` | — | ✅ | ✅ | админка владельца, членство проверяется внутри |
| `is_valid_theme`, `is_supported_currency` | — | ✅ | ✅ | CHECK-ограничения `shops`/`orders` при записи владельцем и сервером |
| `create_order`, `get_customer_orders` | — | — | ✅ | Edge Functions `checkout` / `my-orders` после проверки initData |
| `order_to_json`, `order_status_transition_allowed` | — | — | ✅ | только внутри SECURITY DEFINER-функций (от владельца) |
| `set_updated_at` | — | — | — | только триггеры |

Сняты права, которых раньше не было в миграциях: `anon` больше не вызывает `is_shop_member`, `is_platform_admin`,
`storage_object_shop_id` (все политики с ними действуют только `to authenticated`). `anon`/`authenticated` не вызывают
`order_status_transition_allowed`, его не вызывает ни один клиентский код. `PUBLIC` больше не вызывает `is_valid_theme`,
`is_supported_currency`, `set_updated_at`.

**Default privileges** (для роли, применяющей миграции, без `FOR ROLE`, то есть `current_user` = `postgres`):
`revoke execute on functions from public` (глобально), а в схеме `public` `revoke all on functions / tables / sequences from anon, authenticated`.
Defaults для `service_role` сохранены. Default privileges роли `supabase_admin` миграция от `postgres` изменить не может:
они касаются только объектов, созданных `supabase_admin`, а наши миграции от неё объекты не создают.
Миграция сама проверяет результат и падает, если: функция в `public` принадлежит не `current_user`; осталось EXECUTE
для `PUBLIC`/`anon`/`authenticated` вне allowlist (включая неизвестные функции); defaults `current_user` что-то открывают.

| # | Проверка | Команда | Результат |
| --- | --- | --- | --- |
| 1 | Применение локально | `pnpm exec supabase migration up --local` | ✅ применена `20261017090000` |
| 2 | Воспроизводимость миграций | `pnpm exec supabase db diff --local` (shadow-БД из 7 миграций) | ✅ «No schema changes found» |
| 3 | Новые тесты прав | `vitest … tests/integration/function-privileges.test.ts` | ✅ 10 тестов |
| 4 | Тест ловит регрессию | временный локальный `grant execute on create_order to anon`, затем тот же файл | ✅ 2 теста упали как ожидалось (и `anon` реально создал заказ с поддельным Telegram ID); права возвращены `revoke`, повторные прогоны зелёные |
| 5 | SQL/integration целиком | `pnpm test:integration` (два прогона) | ✅ 5 файлов, **40 тестов** (было 30) |
| 6 | ESLint / TypeScript / Unit | `pnpm lint`, `pnpm typecheck`, `pnpm test` | ✅ 0 ошибок; без ошибок; 12 файлов, 92 теста |
| 7 | Playwright E2E (**исторический результат 17.10.2026, в сессии 18.10.2026 не перепроверялся**) | `pnpm test:e2e` | ⚠️→✅ 1-й прогон: 15/16, упал первый тест `admin-product-create` (таймаут ожидания ссылки «Mint Lab»). Отдельный прогон этого spec и 2-й полный прогон: ✅ **16/16**. Те же запросы админки от временного владельца `mint-lab` вернули магазин без ошибок, поэтому связи с миграцией нет. Точная причина не установлена; первый прогон шёл вдвое дольше (3,0 мин против 1,5), похоже на холодный старт dev-сервера |

**Что проверяет `tests/integration/function-privileges.test.ts`** (права ролей читаются прямо из PostgreSQL через
`supabase db query --local`; helper отказывается работать не с локальным стеком):

1. Матрица `has_function_privilege` для `anon`/`authenticated`/`service_role` и ACL `PUBLIC` по **всем** функциям `public`
   точно равна allowlist. Новая непроверенная функция роняет тест.
2. Функция, таблица и identity-последовательность, созданные `postgres`, не получают прав для `PUBLIC`/`anon`/`authenticated`
   (в блоке с гарантированным откатом).
3. **Симуляция hosted:** в откатываемом блоке восстанавливаются hosted default privileges и прямые GRANT из удалённого дампа
   17.10.2026, проверяется, что баг воспроизведён (`anon`/`authenticated` → `create_order` = true), затем выполняется текст
   миграции. Матрица снова равна allowlist, новые объекты закрыты.
4. API: `anon` не вызывает `create_order` с поддельным Telegram ID (заказа нет, остаток не изменился), не читает
   `get_customer_orders`/`order_to_json` (контакты не утекают), не меняет статус и остаток через `admin_*`, не вызывает
   `is_shop_member`. Витрина (`shop_is_public`, каталог через RLS) работает.
5. Владелец другого магазина: `create_order`, `get_customer_orders`, `order_to_json` дают permission denied; `admin_*` на чужих
   объектах дают `order_not_found`/`variant_not_found`; чужой заказ не читается.
6. Владелец своего магазина: `is_shop_member`, `admin_set_variant_stock`, `admin_set_order_status`, чтение своих заказов,
   `UPDATE shops`/`products` (CHECK-функции и триггер `updated_at` под `authenticated`) работают.
7. Edge Functions `checkout` (201) и `my-orders` (свои заказы, чужой по `orderId` не виден) работают под `service_role`.

На 17.10.2026 hosted-состояние проверялось только симуляцией по удалённому дампу (пункт 3). Проверка на самой hosted-БД
после применения описана в следующем разделе.

## Применение исправления прав на hosted — 18.10.2026

Проект: `xcbugcjmddtubytpvffa`. Миграция: `supabase/migrations/20261017090000_harden_function_privileges.sql`.
Выполнено после подтверждения владельца. Edge Functions, секреты, Auth и tenants **не изменялись**, данные не создавались.
Ключи в документ и в вывод команд не попадали.

**Применение и история миграций (фактический результат)**

| Проверка | Команда | Результат |
| --- | --- | --- |
| Привязка проекта | `type supabase\.temp\project-ref` | ✅ `xcbugcjmddtubytpvffa` |
| Предварительная проверка | `pnpm exec supabase db push --dry-run` | ✅ exit 0, к отправке ровно 1 миграция `20261017090000_harden_function_privileges.sql` |
| Применение | `pnpm exec supabase db push --yes` | ✅ exit 0, «Applying migration 20261017090000_harden_function_privileges.sql… Finished supabase db push» |
| История миграций | `pnpm exec supabase migration list` (после push и повторно перед HTTP-проверкой) | ✅ 7 из 7 версий, у `20261017090000` `local` = `remote` |

**Каталог привилегий (фактический результат по каталогу PostgreSQL)**

| Проверка | Команда | Результат |
| --- | --- | --- |
| GRANT на функции `public` | `pnpm exec supabase db dump --linked --schema public` | ✅ у всех 14 функций `REVOKE ALL … FROM PUBLIC`; `create_order`, `get_customer_orders`, `order_to_json`, `order_status_transition_allowed` выданы только `service_role`; `anon` есть только у `shop_is_public`, `product_is_public`; у `set_updated_at` нет GRANT клиентским ролям; распределение совпадает с allowlist выше |
| Default privileges | тот же дамп | ✅ для `postgres` в схеме `public` новые функции по умолчанию получают только `postgres` и `service_role` |
| `has_function_privilege` | `pnpm exec supabase db query --linked "select has_function_privilege(…)"` (только чтение) | ✅ `anon` → `create_order` = false, `anon` → `get_customer_orders` = false, `authenticated` → `create_order` = false, `authenticated` → `get_customer_orders` = false; `service_role` → `create_order` = true |

**HTTP-проверка через публичные ключи (фактический результат для `anon`)**

`POST https://xcbugcjmddtubytpvffa.supabase.co/rest/v1/rpc/<функция>`. Ключи получены через `supabase projects api-keys`
и использованы только в памяти временного скрипта (скрипт удалён). `service_role` не использовался. Аргументы выбраны так,
чтобы при открытом доступе ответ был другим: `create_order` с `p_customer_tg_id = 0` выбросил бы `invalid_customer` (P0001)
до любых записей; `get_customer_orders` с несуществующим slug и `p_customer_tg_id = 0` только читает и вернул бы `200 []`.
Реальные Telegram ID, имена и телефоны не передавались.

| Ключ | RPC | HTTP | Тело ответа |
| --- | --- | --- | --- |
| legacy anon JWT (`apikey` + `Authorization: Bearer`) | `create_order` | 401 | `{"code":"42501","details":null,"hint":null,"message":"permission denied for function create_order"}` |
| legacy anon JWT | `get_customer_orders` | 401 | `{"code":"42501","details":null,"hint":null,"message":"permission denied for function get_customer_orders"}` |
| publishable key (`apikey`) | `create_order` | 401 | `{"code":"42501","details":null,"hint":null,"message":"permission denied for function create_order"}` |
| publishable key | `get_customer_orders` | 401 | `{"code":"42501","details":null,"hint":null,"message":"permission denied for function get_customer_orders"}` |

Во всех четырёх случаях отказ получен на уровне привилегий (SQLSTATE `42501`), а не из-за аргументов. Это подтверждает
закрытый доступ **для роли `anon`**.

**Hosted-данные не изменились (фактический результат).** `pnpm exec supabase db query --linked` (только `SELECT count(*)`)
до и после HTTP-проверки: `orders`, `order_items`, `inventory_movements`, `shop_order_counters`, `shops`, `auth.users` = 0,
сумма `product_variants.stock_quantity` = 0. После локальных integration-тестов повторно проверены `orders`, `shops`,
`auth.users`: по-прежнему 0.

**Edge Functions и секреты (фактический результат на момент последней проверки)**

| Проверка | Команда | Результат |
| --- | --- | --- |
| Развёрнутые функции | `pnpm exec supabase functions list --project-ref xcbugcjmddtubytpvffa` | ❌ список пуст: `checkout` и `my-orders` **не развёрнуты** |
| Секреты | `pnpm exec supabase secrets list --project-ref xcbugcjmddtubytpvffa` | ⚠️ есть только `SUPABASE_DB_URL`; `TELEGRAM_BOT_TOKEN` **отсутствует** (обязателен: `requireEnv` в `supabase/functions/_shared/auth.ts`); `ALLOWED_ORIGINS` **не настроен** (по коду CORS по умолчанию `*`) |

`SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` hosted Supabase обычно подставляет в Edge Functions сам; пока функции
не развёрнуты, это не проверено.

**Локальная регрессия (фактический результат в сессии 18.10.2026)**

| Проверка | Результат |
| --- | --- |
| `pnpm lint` | ✅ exit 0 |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm test` | ✅ 12 файлов, 92 теста |
| `pnpm test:integration` (локальный стек; `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` явно очищены) | ✅ 5 файлов, 40 тестов (два прогона) |
| Playwright E2E | не запускался в этой сессии; последний результат 16/16 — исторический (17.10.2026) |

**Косвенное подтверждение (не HTTP)**

* Роль `authenticated`: в каталоге hosted у неё нет `EXECUTE` на `create_order` и `get_customer_orders`
  (`has_function_privilege` = false). Поведение `authenticated` через API проверено только на локальном стеке
  (`tests/integration/function-privileges.test.ts`).

**Не проверено**

* Роль `authenticated` через HTTP на hosted: в Auth нет ни одного пользователя, тестовая учётная запись не создавалась.
* Edge Functions `checkout` / `my-orders` на hosted (не развёрнуты).
* Пробный заказ не выполнялся; полный облачный сценарий оформления заказа (Telegram initData → `checkout` →
  `create_order` → `my-orders`) **не подтверждён**.
