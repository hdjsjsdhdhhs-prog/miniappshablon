# Production release (архитектура C)

Production обновляется **только** ручным workflow `.github/workflows/release.yml`. Обычный CI (`ci.yml`) лишь
проверяет код: merge в `main` больше ничего не деплоит. `supabase-deploy.yml` — reusable workflow без собственного
триггера, его вызывает только `release.yml`.

```
preflight ──▶ supabase ──▶ smoke-api ──▶ frontend ──▶ smoke-web
без секретов   environment:   read-only     environment:          read-only
               production     (public key)  production-frontend
               (approval)                   (approval)
```

| Job | Что делает | Доступ |
| --- | --- | --- |
| `preflight` | запуск вручную из `refs/heads/main`; `sha` — полный SHA и равен коммиту запуска; коммит в истории `main`; CI-run (`ci.yml`, push в `main`) и три обязательные проверки (`Lint · types · unit · build`, `Edge Functions · deno check`, `SQL/integration + Playwright (local Supabase in Docker)`) зелёные на этом SHA; `backup_verified = true` и непустой `backup_reference`; SHA-256 manifest миграций; в manifest только разрешённые стадии (3A, 3B); окружения `production` и `production-frontend` существуют и защищены | `GITHUB_TOKEN`: contents/actions/checks read. Секретов нет |
| `supabase` | `supabase-deploy.yml`: guard (main, вызов только из `release.yml@refs/heads/main`, SHA), integrity, Session Pooler, history + dry-run → Migration Gate, allowlist стадий, `db push` целыми стадиями с перепроверкой, `verify-applied`, деплой 4 Edge Functions | environment `production` (одобрение владельца, только `main`) |
| `smoke-api` | только безопасные запросы с публичным ключом: Auth health; `product_variants.stock_status` читается и содержит только `in_stock / low_stock / out_of_stock`; запросы витрины (embed и фильтр по `stock_status`); RPC `admin_variant_stock` существует и отказывает anon (42501); каждая Edge Function отвечает своим 405 на GET; `checkout` без Telegram initData → 401 `telegram_auth_failed` (до разбора тела и до БД). Информационно: читается ли legacy `stock_quantity` (совместимость старого frontend). Перед frontend повторно проверяет защиту окружений | `GITHUB_TOKEN`: contents/actions read; `vars.VITE_SUPABASE_*` (публичные) |
| `frontend` | checkout ровно выбранного SHA, `pnpm install --frozen-lockfile`, production build, `check:bundle-secrets`, `wrangler pages deploy … --branch=main --commit-hash=<sha>` | environment `production-frontend` (одобрение владельца) |
| `smoke-web` | URL этого деплоя и production-адрес: app shell на `/`, `/s/<slug>/`, `/s/<slug>/catalog`, `/admin`; все JS-чанки загружаются; бандл запрашивает `stock_status`, не запрашивает legacy `stock_quantity`; ссылается на ожидаемый Supabase-проект | только публичные адреса |

Ни один job не создаёт заказов и не меняет данные покупателей.

## Как выпустить релиз

1. PR смёржен в `main`, CI для коммита `main` зелёный.
2. Создайте и проверьте резервную копию production БД (Supabase Dashboard → Database → Backups / PITR или
   `pg_dump` через Session Pooler). Запишите её идентификатор.
3. Actions → **Production release** → Run workflow, ветка **main**:
   - `sha` — полный SHA текущего HEAD `main` (`git rev-parse origin/main`);
   - `backup_reference` — идентификатор копии из шага 2 (одна строка, без секретов);
   - `backup_verified` — отметьте, только если копия реально создана и проверена.
4. Одобрите `production` (Supabase). Дождитесь `smoke-api`.
5. Одобрите `production-frontend` (Cloudflare). Дождитесь `smoke-web`.

**Политика выбора SHA.** Релизится ровно тот коммит, для которого запущен workflow (`github.sha` = HEAD `main` в
момент запуска). Другой SHA, сокращённый SHA или запуск не из `main` останавливают preflight. Если `main` уйдёт
вперёд во время релиза, выпускается введённый коммит, он остаётся предком `main`.

**Concurrency.** Одна группа `production-release`, `cancel-in-progress: false`: релизы идут строго по одному,
идущий релиз автоматически не отменяется. GitHub держит в очереди не больше одного ожидающего запуска: более новый
запуск заменяет ожидающий, который ещё ничего не сделал.

## Промежуточное состояние: БД обновлена, frontend нет

Сценарий: `supabase` и `smoke-api` прошли, а одобрение `production-frontend` отклонено или `frontend` / `smoke-web` упал.

- Схема БД и Edge Functions уже новые, frontend остаётся предыдущим.
- Release-миграции обязаны быть **Expand**: старый frontend должен работать на новой схеме. Pipeline не применяет
  Contract-стадии: preflight и Supabase job пропускают только стадии из `RELEASE_ALLOWED_STAGES`
  (`scripts/lib/release.ts`, сейчас `3A`, `3B`). Появление `3C` в manifest или в плане останавливает релиз до `db push`.
- `smoke-api` печатает `legacy_frontend=compatible|incompatible` (job output и warning в логе):
  - `compatible` — старый frontend читает свои данные, повторять frontend можно спокойно;
  - `incompatible` — схема уже скрывает `stock_quantity` от anon, витрина старого frontend не загружает товары до
    успешного деплоя нового frontend. Повторите frontend как можно скорее или восстановите БД из копии (ниже).
  > На момент создания pipeline стадия `3B` (`20261102090100_stock_status_projection.sql`) в PR #1 отзывает у
  > anon SELECT на `stock_quantity`, то есть она **не** Expand-совместима со старым frontend. До первого релиза её
  > нужно разделить на Expand (3B) и Contract (3C) в PR #1, иначе между `supabase` и `frontend` витрина будет
  > недоступна.

**Повторить frontend (тот же релиз).** Actions → запуск релиза → **Re-run failed jobs**. Перезапустятся `frontend`
и `smoke-web` с теми же SHA и inputs. Успешные `preflight`, `supabase`, `smoke-api` не повторяются, БД не
трогается. Потребуется снова одобрить `production-frontend`.

**Повторить релиз целиком.** Новый запуск для того же SHA: Migration Gate увидит, что все стадии применены (`skip`),
и не выполнит `db push`. Edge Functions будут переразвёрнуты тем же кодом, затем пойдут smoke и frontend.

**Остановить релиз.**
- Отклоните ожидающее одобрение (`production` или `production-frontend`): job не стартует, следующие jobs
  пропускаются.
- Или Cancel workflow, пока job **ожидает одобрения**. Не отменяйте `supabase`, пока он выполняется: прерванный
  `db push` может оставить стадию частично применённой. Gate следующего запуска такое состояние отклонит, и
  потребуется ручной разбор.

**Откат.** Автоматического отката БД **нет**. Варианты:
- frontend — повторный деплой предыдущей сборки в Cloudflare Pages (Deployments → Rollback) или релиз предыдущего
  коммита (если он совместим с текущей схемой);
- БД — восстановление из копии `backup_reference` вручную владельцем (PITR / restore). Затем история миграций
  должна совпасть с manifest, иначе Gate остановит следующий релиз.

## Ручные настройки (владелец репозитория)

1. Создать environment **`production-frontend`**: Required reviewers (владелец), Prevent administrators from
   bypassing, Deployment branches → Selected branches → только `main`. Пока его нет или он не защищён, preflight
   останавливает релиз до любых изменений. Workflow никогда не создаёт окружение сам: GitHub создал бы его без
   защиты, но job `frontend` не стартует, пока preflight и smoke-api не подтвердили защиту.
2. Рекомендуется перенести `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID` из secrets репозитория в secrets
   окружения `production-frontend`. Сейчас это secrets уровня репозитория: их может прочитать любой workflow с любой
   ветки (не форка). Имена менять не нужно, workflow читает `secrets.CLOUDFLARE_*` в обоих случаях.
3. Variables остаются прежними: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `CLOUDFLARE_PAGES_PROJECT`
   (уровень репозитория; smoke-jobs читают их без environment). Опционально `PRODUCTION_APP_URL`, если production-домен
   не `https://<CLOUDFLARE_PAGES_PROJECT>.pages.dev`.
4. Production branch проекта Cloudflare Pages должен быть `main` (деплой идёт с `--branch=main`).
5. Удалить или обновить старые ветки, где `supabase-deploy.yml` ещё содержит `workflow_dispatch` (например
   `release/fulfillment-catalog-delete`). Секреты `production` им не выдаются (deployment branches = `main`),
   но лишние входы лучше убрать.
