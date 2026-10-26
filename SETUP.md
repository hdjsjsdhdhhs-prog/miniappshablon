# SETUP: Supabase, Edge Functions, секреты, Telegram, хостинг

## 0. Требования

Node 22+, pnpm 10, Docker (для локального Supabase). Supabase CLI ставится как devDependency (`pnpm exec supabase`).

## 1. Локальная разработка

```bash
pnpm install
pnpm db:start        # = supabase start + локальные секреты Edge Runtime (scripts/supabase-start.ts)
```

`pnpm db:start` передаёт в Edge Runtime **локальный** `TELEGRAM_BOT_TOKEN=123456789:LOCAL_TEST_TOKEN_NOT_A_SECRET`.
С этим токеном тесты подписывают initData, а функции честно его проверяют. В Telegram этот токен недействителен.
Локальный `pnpm db:start` всегда использует этот placeholder; реальный токен задаётся отдельно только в hosted Supabase.

Уведомления о заказах в Telegram локально уходят **только в mock Bot API**: `pnpm db:start` передаёт в Edge Runtime
`TELEGRAM_API_BASE` с локальным адресом mock, а mock запускается командой `pnpm telegram:mock`
(integration- и E2E-тесты поднимают его сами и отказываются работать, если Edge Runtime смотрит не на mock).
Отправленные сообщения видны на http://127.0.0.1:54390/__mock/messages. Стек, запущенный до появления этой
переменной, перезапустите: `pnpm db:stop && pnpm db:start` (данные сохраняются).
Для доступа Edge Runtime к mock-серверу `pnpm db:start` создаёт в Linux отдельную bridge-сеть с gateway
`172.30.0.1` и запускает Supabase в ней. Mock слушает на всех интерфейсах. В Windows Docker Desktop используется
встроенный `host.docker.internal`.
Скрипты (`tenant:*`, `owner:add`, тесты) берут URL и ключи локального стека из `supabase status`.
Для удалённого проекта задайте в shell `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` и не храните их в Git.

Локальная почта (Mailpit): http://127.0.0.1:54324. Studio: http://127.0.0.1:54323.

## 2. Hosted Supabase

> Создание проекта и смена тарифа выполняются вручную владельцем аккаунта. Агент тарифы не меняет.
> Supabase Free (сверено с https://supabase.com/pricing 14.10.2026): БД 500 МБ, Storage 1 ГБ, egress 5 ГБ,
> 50 000 MAU, **пауза проекта после недели неактивности**, до 2 активных проектов, **без автоматических бэкапов**.
> Для коммерческой эксплуатации нужен Pro или выше.

1. Создайте проект в https://supabase.com/dashboard и запишите `project-ref` и пароль БД.
2. Примените миграции из Git и задеплойте функции:
   ```bash
   pnpm exec supabase login
   pnpm exec supabase link --project-ref <project-ref>
   pnpm exec supabase db push                 # supabase/migrations/*
   pnpm exec supabase functions deploy checkout
   pnpm exec supabase functions deploy my-orders
   pnpm exec supabase functions deploy notification-settings
   pnpm exec supabase functions deploy platform-admin
   ```
   То же самое делает ручной workflow `.github/workflows/supabase-deploy.yml`
   (secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, variable `SUPABASE_PROJECT_REF`).
   `verify_jwt = false` для функций берётся из `supabase/config.toml`: покупатель авторизуется через initData, а не через JWT.
3. Секреты функций (только сервер):
   ```bash
   pnpm exec supabase secrets set TELEGRAM_BOT_TOKEN=<токен от BotFather> \
     TELEGRAM_INITDATA_MAX_AGE_SEC=86400 ALLOWED_ORIGINS=https://<ваш-домен>
   ```
4. Auth → Providers → **Email: включён**, **Allow new users to sign up: выключено** (Auth → Settings).
   Владельцев создаёт администратор: `pnpm owner:add --slug <slug> --email <email>`
   (пароль берётся из `OWNER_PASSWORD` или генерируется и печатается один раз).
5. В Auth → URL Configuration укажите Site URL и redirect `https://<домен>/admin`.
6. Администратор платформы (раздел «Все магазины платформы», передача магазинов клиентам) назначается только
   оператором: `pnpm owner:add --email <email> --platform-admin`. Права проверяются на сервере по таблице
   `platform_admins`; email, метаданные пользователя или данные из браузера роль не дают.
7. Уведомления о заказах: токены ботов владельцы вводят в админке магазина («Уведомления»), сервер хранит их
   в Supabase Vault (миграция `20261025090000_*`). Для hosted `TELEGRAM_API_BASE` **не задаётся** (по умолчанию
   `https://api.telegram.org`). Расширение `supabase_vault` в hosted-проектах включено по умолчанию.

### Правило для будущих миграций

В hosted-проектах новые таблицы по умолчанию получают права для `anon`/`authenticated`. В каждой новой миграции:
`alter table … enable row level security;`, затем `revoke all on <table> from anon, authenticated;` и явные `grant`
только на нужные колонки. Для `SECURITY DEFINER`-функций обязательны `revoke all … from public` и точечный `grant execute`.
После изменения схемы выполните `pnpm db:types` и проверку воспроизводимости `pnpm exec supabase db diff --local`
(ожидается «No schema changes found»).

## 3. Frontend-хостинг

Сборка статическая и одна на все магазины. Публичные переменные сборки:

| Переменная | Значение |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | anon/publishable key (защищён RLS) |

После `pnpm build` всегда запускайте `pnpm check:bundle-secrets`.

**Vercel.** Импортируйте Git-репозиторий; `vercel.json` задаёт `pnpm build`, `dist` и SPA-rewrite для глубоких ссылок
`/s/...` и `/admin/...`. Переменные задайте отдельно для Preview и Production.
> Vercel Hobby (https://vercel.com/docs/plans/hobby) разрешён только для **некоммерческого личного** использования.
> Продаваемому сервису нужен Pro; смена плана выполняется владельцем вручную.

**Cloudflare Pages.** Workflow `.github/workflows/ci.yml` (job `deploy-cloudflare-pages`) деплоит `dist` при push в `main`, если заданы
variable `CLOUDFLARE_PAGES_PROJECT`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` и secrets `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`. SPA fallback задаётся в `public/_redirects`.

Заголовок `X-Frame-Options` намеренно не ставится: Telegram Web открывает Mini App в iframe.

## 4. Telegram

Используется один общий бот на всю платформу, магазин выбирается параметром `startapp`.

1. В @BotFather: `/newbot`, затем токен сохраняется **только** в `supabase secrets set TELEGRAM_BOT_TOKEN=…`.
2. `/newapp`: выберите бота, Web App URL = `https://<домен>/`, short name, например `shop`.
3. Ссылка магазина: `https://t.me/<bot_username>/<short_name>?startapp=<slug>`.
   Маршрут `/` читает `start_param` и открывает `/s/<slug>/`.
   Пропишите `telegram.botUsername` и `telegram.miniAppShortName` в `shop.config.json`: тогда `tenant:verify` выведет готовую ссылку.
4. Отдельный бот на магазин потребует отдельной проверки токена на сервере. В текущей версии это сознательно не реализовано:
   функции проверяют подпись только одним `TELEGRAM_BOT_TOKEN`.

## 5. CI (GitHub Actions)

`ci.yml`: lint → typecheck → unit → валидация всех tenants → build → проверка бандла на секреты, затем локальный
Supabase в Docker → проверка воспроизводимости миграций → seed/publish/verify demo → integration → Playwright.
