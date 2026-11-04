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
| `preflight` | запуск вручную из `refs/heads/main`; `sha` — полный SHA и равен коммиту запуска; коммит в истории `main`; CI-run (`ci.yml`, push в `main`) и три обязательные проверки (`Lint · types · unit · build`, `Edge Functions · deno check`, `SQL/integration + Playwright (local Supabase in Docker)`) зелёные на этом SHA; ровно одно из двух: `backup_verified = true` и непустой `backup_reference` (режим `BACKUP_VERIFIED`, **только утверждение оператора**: pipeline не проверяет ни наличие, ни целостность, ни восстановимость копии) **или** `data_loss_accepted = true` при пустом `backup_reference` (режим `DATA_LOSS_ACCEPTED_NO_BACKUP`: копии нет, потеря текущих данных принята) — см. [Backup](#backup--открытый-блокер); SHA-256 manifest миграций; в manifest только разрешённые стадии (3A, 3B); окружения `production` и `production-frontend` существуют и защищены | `GITHUB_TOKEN`: contents/actions/checks read. Секретов нет |
| `supabase` | `supabase-deploy.yml`: guard (main, вызов только из `release.yml@refs/heads/main`, SHA), integrity, Session Pooler, history + dry-run → Migration Gate, allowlist стадий, `db push` целыми стадиями с перепроверкой, `verify-applied`, деплой 4 Edge Functions | environment `production` (одобрение владельца, только `main`). Secrets не на уровне job: `SUPABASE_DB_URL` — только шаги Session Pooler / migration list / dry-run / db push / verify; `SUPABASE_ACCESS_TOKEN` — link и functions deploy/list; `SUPABASE_DB_PASSWORD` — только link. `pnpm install`, checkout и проверки Gate секретов не получают. Эти три имени `release.yml` передаёт явно (`secrets:` вызова, объявлены в `workflow_call.secrets`; без этого вызванный workflow видит их пустыми даже в `production`), шаг link падает сразу, если token или пароль пусты |
| `smoke-api` | только безопасные запросы с публичным ключом: Auth health; `product_variants.stock_status` читается и содержит только `in_stock / low_stock / out_of_stock`; запросы витрины (embed и фильтр по `stock_status`); RPC `admin_variant_stock` существует и отказывает anon (42501); каждая Edge Function отвечает своим 405 на GET; `checkout` без Telegram initData → 401 `telegram_auth_failed` (до разбора тела и до БД). **Обратная совместимость, fail-closed:** точные запросы старого frontend (`main` 741d478) — embed `product_variants(… stock_quantity …)`, фильтр `in_stock.stock_quantity > 0`, `product_variants?select=*` (те же права, что у `select('*')` старой админки); каждый вариант обязан содержать числовой `stock_quantity`. Любая ошибка останавливает релиз до `frontend`. Перед frontend повторно проверяет защиту окружений | `GITHUB_TOKEN`: contents/actions read; `vars.VITE_SUPABASE_*` (публичные) |
| `frontend` | checkout ровно выбранного SHA, `pnpm install --frozen-lockfile`, production build, `check:bundle-secrets`, `wrangler pages deploy … --branch=main --commit-hash=<sha>` | environment `production-frontend` (одобрение владельца). Только этот job и только шаг деплоя получают secrets окружения `PRODUCTION_CLOUDFLARE_API_TOKEN`, `PRODUCTION_CLOUDFLARE_ACCOUNT_ID`; variable окружения `PRODUCTION_CLOUDFLARE_PAGES_PROJECT`. Старые `CLOUDFLARE_*` не используются (без fallback) |
| `smoke-web` | URL этого деплоя и production-адрес: app shell на `/`, `/s/<slug>/`, `/s/<slug>/catalog`, `/admin`; все JS-чанки загружаются; бандл запрашивает `stock_status`, не запрашивает legacy `stock_quantity`; ссылается на ожидаемый Supabase-проект | только публичные адреса |

Ни один job не создаёт заказов и не меняет данные покупателей.

## Как выпустить релиз

1. PR смёржен в `main`, CI для коммита `main` зелёный.
2. Создайте и проверьте резервную копию production БД (Supabase Dashboard → Database → Backups / PITR или
   `pg_dump` через Session Pooler). Запишите её идентификатор. Если копии нет и владелец принимает потерю текущих
   данных — см. путь B ниже; выдумывать идентификатор копии нельзя.
3. Actions → **Production release** → Run workflow, ветка **main**:
   - `sha` — полный SHA текущего HEAD `main` (`git rev-parse origin/main`);
   - **путь A — копия есть** (`BACKUP_VERIFIED`):
     - `backup_reference` — идентификатор копии из шага 2 (одна строка, 3–200 символов, без секретов);
     - `backup_verified` — отметьте, только если копия реально создана и проверена;
     - `data_loss_accepted` — **не** отмечайте;
   - **путь B — копии нет** (`DATA_LOSS_ACCEPTED_NO_BACKUP`):
     - `backup_reference` — оставьте **пустым**;
     - `backup_verified` — **не** отмечайте;
     - `data_loss_accepted` — «I acknowledge that no restorable backup exists and accept the loss of current database
       data.» Отмечайте, только если восстановимой копии действительно нет и владелец принимает потерю всех текущих
       данных production БД. Точки восстановления у такого релиза нет.

   Preflight останавливает релиз (до любого environment и секрета), если не выбран ни один путь, выбраны оба,
   при `data_loss_accepted` указан `backup_reference`, либо на пути A `backup_reference` некорректен. В логе
   preflight режим виден явно: `DATA PROTECTION: BACKUP_VERIFIED` (+ `ATTESTED … NOT verified by this pipeline`) или
   `DATA PROTECTION: DATA_LOSS_ACCEPTED_NO_BACKUP` (+ предупреждение в аннотациях run). `data_loss_accepted` никогда
   не засчитывается как `backup_verified`. Все проверки миграций (SHA-256, history + dry-run, allowlist и порядок
   стадий, перепроверка перед `db push`, `verify-applied`) и одобрения окружений одинаковы на обоих путях.
4. Одобрите `production` (Supabase). Дождитесь `smoke-api`.
5. Одобрите `production-frontend` (Cloudflare). Дождитесь `smoke-web`.

**Политика выбора SHA.** Релизится ровно тот коммит, для которого запущен workflow (`github.sha` = HEAD `main` в
момент запуска); input `sha` обязан с ним совпасть. Другой SHA, сокращённый SHA или запуск не из `main` останавливают
preflight. Ввести произвольный коммит нельзя: **новый** запуск (Run workflow) всегда берёт текущий HEAD `main`.
Исключение — **повтор существующего запуска** (Re-run): он снова выпускает SHA этого запуска, который к тому времени
может быть уже не HEAD (см. «Повтор существующего запуска и исторический SHA» ниже).

- Preflight дополнительно проверяет, что этот коммит **на момент preflight** всё ещё в истории `main`: GitHub compare
  `<sha>...main` (base — SHA релиза, head — текущий `main`) должен вернуть `identical` или `ahead` и `behind_by = 0`.
  Так релиз не выпустит коммит, исчезнувший из `main` (переписанная история), даже если запуск был сделан до этого.
- Если `main` ушёл вперёд, пока запуск ждал (очередь `production-release`, одобрение), compare вернёт `ahead`:
  выпускается **введённый** коммит этого запуска (он остаётся предком `main`), а не более новый HEAD. Для нового HEAD
  нужен новый запуск.
- Если коммита больше нет в истории `main` (`behind`, `diverged`), а также при ошибке или некорректном ответе
  GitHub API preflight останавливает релиз до любого environment и секрета.

**Повтор существующего запуска и исторический SHA.** Поведение GitHub — по официальной документации
«Re-running workflows and jobs»:
- **Новый запуск** (`workflow_dispatch`, Run workflow) и **повтор** (Re-run) — разные операции. Новый запуск получает
  `GITHUB_SHA` = текущий HEAD `main`, и input `sha` обязан с ним совпасть. Повтор **сохраняет** `GITHUB_SHA` и
  `GITHUB_REF` исходного события и его inputs: ввести при повторе другой SHA нельзя, а guards `preflight`,
  `supabase` и `frontend` по-прежнему требуют `refs/heads/main` и `inputs.sha = GITHUB_SHA`.
- Повторить запуск (целиком, упавшие jobs или отдельный job) можно в течение **30 дней** после исходного запуска,
  **не более 50 раз** (полные и частичные повторы вместе), и нельзя, пока workflow отключён. Повтор выполняется с
  правами актора исходного запуска; одобрения `production` / `production-frontend` требуются заново.
- Поэтому **уже не самый новый SHA может быть выпущен ещё раз**: если `main` ушёл вперёд, повтор старого запуска
  деплоит код **его** SHA (Edge Functions, frontend), а не HEAD — при условии, что проходят все остальные проверки:
  - **Re-run all jobs** повторяет `preflight`: compare `<sha>...main` снова должен вернуть `identical`/`ahead` и
    `behind_by = 0`, CI этого SHA зелёный, окружения защищены. SHA, которого больше **нет в истории текущего**
    `main` (`behind`, `diverged`, переписанная история), отклоняется до любого environment и секрета. Совпадения с
    текущим HEAD preflight **не** требует (`ahead` допустим) — это сознательная политика, описанная выше.
  - **Re-run failed jobs** и **Re-run a specific job** успешный `preflight` **не** повторяют: используются его outputs
    из исходной попытки, compare с текущим `main` заново **не** выполняется. Остаются guards самих jobs (`main`,
    `inputs.sha = GITHUB_SHA`, `supabase-deploy.yml` только из `release.yml@refs/heads/main`), Migration Gate и
    одобрения окружений.
  - Migration Gate сравнивает БД с manifest **этого** SHA. Если после него в production применены более новые
    миграции, повтор остановится до `db push` и до функций (история не совпадает с manifest). Если новых миграций
    нет, повтор задеплоит прежний код функций и frontend.
- Не повторяйте старый запуск после того, как `main` ушёл вперёд, если не собираетесь осознанно выпустить код этого
  SHA ещё раз. Для нового кода — новый Run workflow от текущего HEAD `main`.

**Concurrency.** Одна группа `production-release`, `cancel-in-progress: false`: релизы идут строго по одному,
идущий релиз автоматически не отменяется. GitHub держит в очереди не больше одного ожидающего запуска: более новый
запуск заменяет ожидающий, который ещё ничего не сделал.

## Промежуточное состояние: БД обновлена, frontend нет

Сценарий: `supabase` и `smoke-api` прошли, а одобрение `production-frontend` отклонено или `frontend` / `smoke-web` упал.

- Схема БД и Edge Functions уже новые, frontend остаётся предыдущим.
- Release-миграции обязаны быть **Expand**: старый frontend должен работать на новой схеме. Pipeline не применяет
  Contract-стадии: preflight и Supabase job пропускают только стадии из `RELEASE_ALLOWED_STAGES`
  (`scripts/lib/release.ts`, сейчас `3A`, `3B`). Появление `3C` в manifest или в плане останавливает релиз до `db push`.
- `smoke-api` проверяет запросы старого frontend **fail-closed** (предупреждений больше нет): если хотя бы один из них
  не работает, `smoke-api` падает и `frontend` не запускается. Это значит, что БД уже несовместима с frontend,
  который сейчас обслуживает покупателей: не одобряйте frontend «вслепую», а восстановите БД из копии или выпустите
  исправляющую Expand-миграцию.
- Stock status (3B, `20261102090100_stock_status_projection.sql`) — **Expand**: добавляются `stock_status`,
  `admin_variant_stock` и защита checkout от подбора остатка; права на `product_variants` не меняются, старый
  frontend читает `stock_quantity` как раньше. **Contract (3C)** — отзыв табличного SELECT у anon/authenticated и
  column grants без `stock_quantity` — выпускается **отдельным** изменением только после деплоя нового frontend и
  периода наблюдения. Это изменение должно одновременно: добавить миграцию 3C в manifest, разрешить `3C` в
  `RELEASE_ALLOWED_STAGES` и убрать из `smoke-api` проверку запросов старого frontend (иначе smoke-api
  справедливо остановит релиз). В текущем релизе 3C нет (проверяется `migration-integrity.test.ts`).

**Повторить frontend (тот же релиз).** Actions → запуск релиза → **Re-run failed jobs**. Перезапустятся `frontend`
и `smoke-web` с теми же SHA и inputs. Успешные `preflight`, `supabase`, `smoke-api` не повторяются, БД не
трогается. Потребуется снова одобрить `production-frontend`.

**Повторить релиз целиком.** Для того же SHA — **Re-run all jobs** этого же запуска (тот же `github.sha` и те же
inputs; preflight заново проверит CI, окружения и что коммит всё ещё в истории `main`, но не то, что он HEAD — см.
«Повтор существующего запуска и исторический SHA»). Новый запуск через Run workflow возможен только для текущего
HEAD `main`: пока `main` не сдвинулся, это тот же SHA. В обоих случаях, если после этого релиза новых миграций не
было, Migration Gate увидит, что все стадии применены (`skip`), и не выполнит `db push`; Edge Functions будут
переразвёрнуты кодом этого SHA, затем пойдут smoke и frontend.

## Частичный деплой Edge Functions

**Деплой функций не атомарный.** Job `supabase / Migrations + Edge Functions (production)` (`supabase-deploy.yml`, job
`deploy`) после `verify-applied` выполняет **последовательные шаги** одного job: `checkout` → `my-orders` →
`notification-settings` → `platform-admin` → `List deployed Edge Functions`. Каждый шаг — отдельный
`supabase functions deploy <name>` (таймаут шага 10 минут, у списка — 5). `continue-on-error` и условий у них нет.

**Что происходит, если падает N-й шаг** (ошибка CLI или Management API, таймаут шага, таймаут job):
- шаги после N и `List deployed Edge Functions` не выполняются, job падает;
- миграции к этому моменту **уже применены** и подтверждены `verify-applied` (функции деплоятся только после этого
  шага). Откатывать БД из-за сбоя функции не нужно;
- функции 1…N−1 уже работают на коде этого SHA, функции N+1…4 — на предыдущем коде. Состояние функции N
  **неизвестно**: сбой мог произойти до или после того, как платформа приняла новую версию. В production одновременно
  работают **функции разных версий**;
- `smoke-api`, `frontend` и `smoke-web` пропускаются (`needs`), frontend остаётся предыдущим. Smoke смешанный
  набор функций не проверял: проверка `smoke-api` (GET → 405) подтверждает только, что функция отвечает, но не её
  версию.

**Повтор — как это работает на самом деле.** GitHub перезапускает **jobs, а не шаги**: job начинается с первого
шага на новом runner. Перезапуск использует тот же `GITHUB_SHA` и `GITHUB_REF`, а `supabase-deploy.yml` — из того же
коммита. Перезапустить можно в течение 30 дней, не более 50 раз (см. «Повтор существующего запуска и исторический
SHA»).
- **Re-run failed jobs** — перезапускает упавшие jobs и **зависящие от них**: `supabase / …` (снова одобрение
  `production`), затем `smoke-api`, `frontend`, `smoke-web`. `preflight` не повторяется, его outputs (SHA) берутся из
  первой попытки (compare с текущим `main` заново не выполняется). Job `deploy` проходит все шаги заново: guard, integrity, project ref, link, Session Pooler, history +
  dry-run. Gate видит, что все стадии применены (`skip`), и `db push` **не выполняется**. Затем **все четыре** шага
  `functions deploy` выполняются снова, включая уже успешные (повторный деплой того же кода). Это следует из того, что
  все четыре — безусловные шаги одного job. Если повтор упадёт раньше (например, Gate увидит неожиданное состояние
  истории), функции не деплоятся.
- **Re-run a specific job** (`supabase / Migrations + Edge Functions (production)`) — тот же job и его зависимые
  (`smoke-api`, `frontend`, `smoke-web`); при единственном упавшем job результат тот же, что у Re-run failed jobs.
  Повторить отдельный шаг (одну функцию) через GitHub нельзя.
- **Re-run all jobs** — заново все jobs, начиная с `preflight` (повторно проверяет CI, что коммит в истории `main`,
  защиту окружений; inputs те же). Дальше так же, как выше.
- **Отдельно запустить `supabase-deploy.yml` нельзя**: у reusable workflow нет своего триггера (`workflow_call`
  only), а guard принимает только вызов из `release.yml@refs/heads/main`. Новый **Run workflow** у `release.yml` —
  это новый релиз текущего HEAD `main` (тот же SHA, только если `main` не сдвинулся).

**Что проверить перед повтором:**
1. Лог упавшего шага: какая функция, какая ошибка. Временные сбои (сеть, 5xx Management API, rate limit,
   таймаут шага) имеет смысл повторить; детерминированные (ошибка bundling/кода, нет прав у токена, проект на паузе)
   повтор не исправит.
2. В логе этой попытки шаг `Verify migration history after push` прошёл (иначе это не сбой функций, а сбой
   миграций — см. «Прерванный db push (Cancel или таймаут)»).
3. Supabase Dashboard → Edge Functions: версия и время обновления каждой из четырёх функций — какие уже обновлены,
   в каком состоянии функция N.
4. Повтор деплоит **тот же SHA**: исправление кода повтором не попадёт в production.

**Если сбой устойчивый:**
- проблема в доступе (`SUPABASE_ACCESS_TOKEN` в environment `production` просрочен или без прав) — владелец меняет
  секрет вручную, затем Re-run failed jobs (secrets читаются при старте job);
- проблема в коде функции этого SHA — исправление через PR в `main`, затем новый релиз нового HEAD (Gate `skip` для
  БД, все четыре функции из нового SHA). До этого смешанное состояние функций сохраняется, frontend не обновлён;
- если смешанное состояние недопустимо до исправления — владелец вручную, **вне pipeline**, своими учётными
  данными деплоит прежнюю версию затронутых функций из checkout предыдущего релизного коммита
  (`supabase functions deploy <name> --project-ref xcbugcjmddtubytpvffa`). Новый запуск pipeline старый коммит не
  выпустит (только текущий HEAD `main`). Повтор прежнего релизного запуска выпустил бы его SHA целиком (все четыре
  функции и frontend), а не отдельную функцию, поэтому для точечного отката он не подходит (см. «Повтор
  существующего запуска и исторический SHA»). Действие и версии записываются в журнал релиза.

**Остановить релиз.**
- Отклоните ожидающее одобрение (`production` или `production-frontend`): job не стартует, следующие jobs
  пропускаются.
- Или Cancel workflow, пока job **ожидает одобрения**. Не отменяйте `supabase`, пока он выполняется: прерванный
  `db push` (Cancel **или** таймаут job) может оставить стадию частично применённой, а результат файла в работе —
  неизвестным. Порядок действий — «Прерванный db push (Cancel или таймаут)»; слепой повтор запрещён.

**Откат.** Автоматического отката БД **нет**. Варианты:
- frontend — повторный деплой предыдущей сборки в Cloudflare Pages (Deployments → Rollback), вручную владельцем.
  Новый запуск pipeline выпускает только текущий HEAD `main` (см. «Политика выбора SHA»). Повтор (Re-run)
  прежнего запуска в пределах 30 дней снова выпустил бы его SHA, если тот всё ещё в истории `main` и проходит
  остальные проверки, — но это повтор всего прежнего релиза, а не откат: БД он не откатывает, а Migration Gate
  остановит его, если после него применены новые миграции (см. «Повтор существующего запуска и исторический SHA»).
  Штатный путь вернуть прежний код через pipeline — новый коммит в `main` (например, revert через PR) и обычный
  релиз этого HEAD — при условии, что он совместим с текущей схемой БД;
- БД — восстановление из копии `backup_reference` вручную владельцем (PITR / restore). Затем история миграций
  должна совпасть с manifest, иначе Gate остановит следующий релиз. Релиз в режиме `DATA_LOSS_ACCEPTED_NO_BACKUP`
  восстановить **нельзя**: копии нет, остаётся только исправляющая миграция через PR и review или пересоздание БД
  с потерей данных (принятой при запуске).

## Бюджет времени job `deploy`

Job `supabase / Migrations + Edge Functions (production)` ограничен **180 минутами** (`timeout-minutes` job;
ожидание одобрения `production` не считается; максимум GitHub — 360). Бюджет (минуты), согласованность проверяет
`scripts/lib/workflows.test.ts`:

| Часть | Шаги | Ограничение | Накопительно |
| --- | --- | --- | --- |
| До `db push`, ничего не меняют в БД | guard 2, checkout 5, SHA 1, pnpm setup 5, setup-node 5, `pnpm install` 10, integrity 5, project ref 2, link 5, Session Pooler 1, `migration list` 5, history + dry-run 10, план 5, стадии 2, бюджет 2 | таймаут **каждого** шага, сумма 65 | 65 |
| Резерв БД | `Apply migrations` (перепроверка + `db push`) и `Verify migration history after push` | **без** таймаута шага, резерв 60 | 125 |
| Edge Functions | 4 × `functions deploy` по 10, `functions list` 5 | таймауты шагов, 45 | 170 |
| Запас runner | Set up job, post-шаги | 10 | 180 |

Таймауты шагов сами по себе не гарантируют резерв (время между шагами, Set up job, будущий шаг без таймаута).
Поэтому guard записывает время старта, а шаг `Time budget left for db push` (только в режиме `apply`) перед
`Apply migrations` **измеряет** прошедшее время и не начинает `db push`, если прошло больше 65 минут
(180 − 60 − 45 − 10). Это остановка **до** изменений БД: Re-run после устранения причины безопасен. Если сработает
таймаут шага до `db push` — тоже. Если таймаут job всё же сработает внутри `Apply migrations` — см. следующий раздел.

## Прерванный db push (Cancel или таймаут)

**Когда.** Шаг `Apply migrations` прерван во время `supabase db push`: Cancel workflow, таймаут job `deploy`,
потеря runner. Для разбора это **одна и та же ситуация**: runner убивает процесс CLI, и результат последнего файла
pipeline не узнаёт.

**Что известно и что нет.**
- Как применяет CLI (`supabase` 2.120.0 из `pnpm-lock.yaml`; исходники `apps/cli-go/pkg/migration/apply.go`,
  `file.go`): файлы по одному, по порядку; перед каждым `RESET ALL`; операторы файла и `INSERT` его версии в
  `supabase_migrations.schema_migrations` отправляются одним pipeline-batch, который PostgreSQL выполняет как одну
  неявную транзакцию. Исключение — операторы, несовместимые с pipeline (`CREATE/DROP INDEX CONCURRENTLY`,
  `REINDEX … CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`, `CLUSTER`): CLI выполняет их отдельно, такой файл применяется
  **не** целиком. В стадиях 3A/3B таких операторов нет (проверяет `workflows.test.ts`). Это вывод из чтения
  исходников этой версии CLI, а **не** проверенная гарантия; при обновлении CLI его нужно перепроверить.
- Файлы, завершившиеся до прерывания, **остаются применёнными**: автоматического отката нет.
- Результат файла, выполнявшегося в момент прерывания, **неизвестен**: он мог быть откачен, а мог быть и
  зафиксирован — сервер может продолжать выполнять уже полученный batch после того, как runner исчез. Нельзя
  утверждать ни «файл всегда откатывается», ни «файл всегда фиксируется».
- Стадия (3A или 3B) поэтому может остаться **частично применённой**.

**Порядок действий — до любого повтора:**
1. **Не нажимайте Re-run** (ни failed, ни all) и не запускайте новый релиз. Gate отклонит частично применённую
   стадию, но если прерывание пришлось на границу стадий (3A целиком, 3B не начата) или файл в работе откатился
   первым в стадии, Gate увидит согласованное состояние, и повтор снова выполнит `db push` — до разбора это слепой
   повтор.
2. Убедитесь, что миграция больше не выполняется: Supabase Dashboard → SQL Editor, только чтение:
   `select pid, state, query_start, left(query, 120) from pg_stat_activity where state <> 'idle' and pid <> pg_backend_pid();`
   Пока сессия миграции активна, результат ещё не определён — дождитесь её завершения.
3. Прочитайте удалённую историю (только чтение): `supabase migration list --db-url "<Session Pooler URI>"` или
   `select version, name from supabase_migrations.schema_migrations order by version;`.
4. Сравните с manifest: `MIGRATION_STAGES` в `scripts/lib/migration-plan.ts` (3A — 5 файлов, 3B — 4) и baseline
   `APPLIED_BASELINE_MIGRATION_FILES`. Для каждой стадии: **применена целиком**, **не начата** или **частично**.
   Тот же вывод делает Gate локально, ничего не меняя: `migration list … --output-format json > list.json`,
   `db push --dry-run … --output-format json > dry.json`, затем
   `pnpm exec tsx scripts/check-production-migration-plan.ts plan list.json dry.json`.
5. **Подтверждённо применённой** считается версия, которая есть в истории, когда активных сессий миграции уже нет.
   Файл, выполнявшийся в момент прерывания, остаётся **неопределённым**, пока не сверены и история, и его объекты в
   схеме (таблицы, функции, политики из этого файла).
6. Если хоть одна стадия частична, история не совпадает с manifest или объекты файла не согласуются с историей —
   **стоп**: никаких дальнейших попыток миграции; разбор владельцем (восстановление из `backup_reference` или
   исправляющая миграция через PR и review; в режиме `DATA_LOSS_ACCEPTED_NO_BACKUP` восстанавливать не из чего). Pipeline частичную стадию не «докатывает».
7. Только если каждая стадия применена целиком или не начата, активных сессий нет и причина прерывания понятна и
   устранена, допустим Re-run: он снова пройдёт integrity, history + dry-run, Gate и проверку бюджета времени до
   `db push`. Результаты шагов 2–6 записываются в журнал релиза.

## Ручные настройки (владелец репозитория)

1. Создать environment **`production-frontend`**: Required reviewers (владелец), Prevent administrators from
   bypassing, Deployment branches → Selected branches → только `main`. Пока его нет или он не защищён, preflight
   останавливает релиз до любых изменений. Workflow никогда не создаёт окружение сам: GitHub создал бы его без
   защиты, но job `frontend` не стартует, пока preflight и smoke-api не подтвердили защиту.
2. В environment **`production-frontend`** создать (вручную, workflow этого не делает):
   - secret `PRODUCTION_CLOUDFLARE_API_TOKEN` — API token Cloudflare только с правом *Cloudflare Pages: Edit* на нужный
     аккаунт;
   - secret `PRODUCTION_CLOUDFLARE_ACCOUNT_ID` — Account ID Cloudflare;
   - variable `PRODUCTION_CLOUDFLARE_PAGES_PROJECT` — имя проекта Cloudflare Pages (не секрет; job `frontend` передаёт
     его в `smoke-web` для адреса по умолчанию `https://<project>.pages.dev`).
   Fallback на старые имена нет: пока этих значений нет, job `frontend` падает до деплоя.
3. Variables уровня репозитория остаются: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (публичные; их читают CI-сборка
   и smoke-jobs без environment). **Проект Supabase зафиксирован в коде**: `PRODUCTION_SUPABASE_PROJECT_REF`
   (`scripts/lib/release.ts`, сейчас `xcbugcjmddtubytpvffa`). `vars.SUPABASE_PROJECT_REF` обязан совпадать с ним
   (проверяется до `supabase link`), а `VITE_SUPABASE_URL` — быть ровно `https://xcbugcjmddtubytpvffa.supabase.co`
   (без порта, пути, query, userinfo; допускается только завершающий `/`). URL проверяется в job `frontend` до
   `pnpm build` (в контексте `production-frontend`) и в `smoke-api` / `smoke-web` до первого запроса. Несовпадение,
   пустое или некорректное значение останавливает релиз; значения в ошибках не печатаются. Смена проекта — только
   изменением этой константы через PR. Опционально `PRODUCTION_APP_URL`, если production-домен не
   `https://<PRODUCTION_CLOUDFLARE_PAGES_PROJECT>.pages.dev` (это единственный документированный fallback).
   `smoke-web` проверяет **оба** адреса, оба обязательны и проверяются до первого запроса: уникальный URL деплоя
   (output `deployment-url` wrangler-action) должен быть ровно `https://<id>.<project>.pages.dev`; production-адрес —
   голый https-origin, а на `pages.dev` — ровно `https://<project>.pages.dev`. Пустой `deployment-url` (wrangler не
   вернул адрес) больше не пропускается молча: `smoke-web` падает. Старые repository secrets `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID` и variable `CLOUDFLARE_PAGES_PROJECT` удалить **после** merge PR #1 и PR #2 в `main`: до
   этого их ещё использует job `deploy-cloudflare-pages` в `ci.yml` текущего `main`.
4. Production branch проекта Cloudflare Pages должен быть `main` (деплой идёт с `--branch=main`).
5. Удалить или обновить старые ветки, где `supabase-deploy.yml` ещё содержит `workflow_dispatch` (например
   `release/fulfillment-catalog-delete`). Секреты `production` им не выдаются (deployment branches = `main`),
   но лишние входы лучше убрать.

## Backup — открытый блокер

`backup_verified=true` в `release.yml` — **утверждение оператора, а не проверка**: preflight лишь требует галочку и
непустой `backup_reference`. Pipeline не доказывает, что копия существует, цела и восстанавливается. Пока ниже не
выбран и не реализован один из вариантов, этот пункт остаётся **открытым блокером первого production-релиза**.
Production backup без отдельного согласования не создаётся; дампы БД **никогда** не загружаются в GitHub Artifacts.

**Явное принятие потери данных (`data_loss_accepted`).** Отдельный путь для случая, когда восстановимой копии нет
(например, в production только одноразовые тестовые данные): оператор не утверждает наличие копии, а прямо
заявляет, что её **нет**, и принимает потерю текущих данных БД. Preflight печатает `DATA_LOSS_ACCEPTED_NO_BACKUP`,
а не `BACKUP_VERIFIED`, и требует пустой `backup_reference`; одновременно с `backup_verified` флаг не принимается.
Это **не** закрывает блокер backup и не является резервной копией: это осознанный релиз без точки восстановления.
Как только в БД появятся данные, которые терять нельзя, этот путь использовать нельзя — нужен путь A.

Важно для всех вариантов: резервная копия БД **не содержит файлов Storage** (bucket `shop-media`: логотипы, фото
товаров), только их метаданные в `storage.objects`. Для полного восстановления нужна отдельная копия bucket.

Цены и лимиты ниже — по документации Supabase / Cloudflare / AWS, известной на момент составления; перед выбором
сверить с https://supabase.com/pricing и https://supabase.com/docs/guides/platform/backups. Текущий тариф
production-проекта из репозитория не виден (SETUP.md: на Free автоматических бэкапов нет).

| Вариант | Credentials | Стоимость / тариф | Хранение | Шифрование | Срок хранения | Восстановление | Проверка доступности |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **1. Supabase daily backups / PITR** | доступ владельца к Dashboard; в CI ничего | Free — нет бэкапов. Pro и выше — ежедневные копии; PITR — платное дополнение (требует compute не ниже Small) | инфраструктура Supabase | at rest — силами Supabase | по тарифу (ориентир: Pro 7 дней, Team 14, Enterprise до 30; PITR — 7/14/28 дней) | Dashboard → Database → Backups / PITR: восстановление проекта целиком на момент времени, с простоем | только визуально в Dashboard (дата последней копии); из CI проверить нельзя без Management API токена |
| **2. Ручной `pg_dump` → внешнее хранилище** | `SUPABASE_DB_URL` (Session Pooler) — лучше отдельная роль только для чтения; ключ записи в хранилище | бесплатно, кроме хранилища | приватный S3-совместимый bucket (R2 / S3), не GitHub | `age` или `gpg` на машине оператора **до** загрузки; приватный ключ офлайн | lifecycle bucket, например 35 дней | `supabase db dump` (roles / schema / data) или `pg_dump -Fc` (клиент PG 17) → `psql` / `pg_restore` в чистую БД | SHA-256 файла записывается рядом; `HEAD` объекта (размер); тестовое восстановление (вариант 4) |
| **3. Job `backup` в Release Pipeline** | environment с approval: read-only DB URL; токен bucket только на один bucket (R2: *Object Read & Write* на bucket); публичный ключ `age` — variable, не секрет | R2: 10 ГБ/мес бесплатно, далее ≈ $0.015/ГБ·мес, без egress; S3 Standard ≈ $0.023/ГБ·мес | приватный bucket, ключ `prod/<дата>-<sha>.dump.age`; Bucket Lock / Object Lock от удаления | `age` на runner публичным ключом; runner не может расшифровать | Bucket Lock + lifecycle (например 35 дней) | как в варианте 2; приватный ключ только у владельца | job вычисляет SHA-256, загружает, затем отдельным запросом проверяет наличие объекта, размер и checksum; `backup_reference` = ключ + SHA-256 формирует job, а не оператор |
| **4. Тестовое восстановление** | приватный ключ `age` (офлайн, у владельца); read-доступ к bucket | бесплатно (локальный Docker) | — | расшифровка только на машине владельца | — | восстановление в disposable-стек (как `tma-migration-gate-cli-test`, порты 5542x, без `link`) | SHA-256 совпал; `migration list` = manifest; контрольные `count(*)` по `shops`, `products`, `orders`; результат фиксируется в журнале релиза |

**Предлагаемая конфигурация** (требует решения владельца и создания хранилища вручную):

1. Cloudflare R2 bucket `miniapp-db-backups` (приватный, без public access, Bucket Lock 35 дней, lifecycle 35 дней);
   отдельный R2 token только на этот bucket.
2. Новый environment `production-backup` (Required reviewers = владелец, только `main`) с secrets
   `BACKUP_DB_URL` (Session Pooler, отдельная роль только для чтения), `BACKUP_R2_ACCESS_KEY_ID`,
   `BACKUP_R2_SECRET_ACCESS_KEY` и variables `BACKUP_R2_ENDPOINT`, `BACKUP_R2_BUCKET`, `BACKUP_AGE_RECIPIENT`.
3. Job `backup` между `preflight` и `supabase`: `pg_dump -Fc` → `age -r` → SHA-256 → upload → проверка объекта
   (размер + SHA-256). `supabase` получает `needs: [preflight, backup]`; input `backup_verified` убирается.
4. Перед первым релизом и далее ежемесячно — тестовое восстановление (вариант 4) владельцем.
5. Если тариф Pro доступен — дополнительно включить ежедневные копии Supabase (вариант 1) как второй уровень.
6. Отдельно решить копирование bucket `shop-media` (например, `rclone sync` в тот же R2 по расписанию).

До реализации п. 1–4 оператор обязан сам сделать и проверить копию (варианты 1 или 2 + 4) и указать её в
`backup_reference`; preflight выводит это как `BACKUP_VERIFIED` / `ATTESTED … NOT verified by this pipeline`. Без
копии — только явный путь `data_loss_accepted` (см. выше).

### Целевая архитектура backup (проект, не реализовано)

Статус: **operator attestation**. Ничего из перечисленного ниже не создано и не запускалось; production backup
не делался. Блокер закрывается только после реализации шагов 1–5 и успешного тестового восстановления (шаг 6).

1. **Защищённое хранилище.** Отдельный приватный bucket (R2 `miniapp-db-backups` или S3) только для копий БД:
   без public access и custom domain; Bucket Lock / Object Lock (retention 35 дней) — копию нельзя удалить или
   перезаписать даже с токеном записи; lifecycle удаляет объекты старше 35 дней. Токен bucket — только на этот bucket,
   хранится в environment `production-backup` (Required reviewers = владелец, deployment branch = `main`). Ключ объекта:
   `prod/<YYYYMMDDTHHMMSSZ>-<release_sha>.tar.age`. Файлы Storage (`shop-media`) — отдельный префикс
   `prod-storage/<дата>/`.
2. **Содержимое и шифрование.** `supabase db dump` трижды (`--role-only`, схема, `--data-only --use-copy`) →
   `roles.sql`, `schema.sql`, `data.sql` + `counts.json` (`count(*)` по `shops`, `products`, `product_variants`,
   `orders`) + `migrations.json` (`migration list`) → `tar` → `age -r <recipient>`. Открытый текст живёт только во
   временном каталоге runner и удаляется в том же step; в Artifacts, логи и cache ничего не попадает. Recipient —
   публичный ключ (variable). Приватный ключ `age` только у владельца, офлайн, в двух местах (менеджер паролей +
   офлайн-носитель); в GitHub его нет, runner расшифровать копию не может.
3. **Контроль SHA-256.** Job считает SHA-256 зашифрованного архива и SHA-256 открытого `tar` (до шифрования). Оба
   пишутся в metadata объекта (`sha256-cipher`, `sha256-plain`) и в sidecar-объект `<key>.sha256`. Upload — с
   checksum SHA-256 на стороне хранилища, если оно его поддерживает (для R2 проверить при реализации), иначе только
   metadata + read-back из шага 4.
4. **Проверка существования объекта.** После upload отдельными запросами: `HeadObject` — объект есть, размер равен
   локальному, metadata совпадает; затем `GetObject` во временный файл и повторный SHA-256 — должен совпасть с
   `sha256-cipher`. Любое расхождение — job падает, `supabase` не стартует. Output job:
   `backup_reference = <bucket>/<key>@sha256:<cipher-hex>` формирует job, а не оператор. В `release.yml`:
   `supabase.needs: [preflight, backup]`, input `backup_verified` удаляется, preflight больше не печатает `ATTESTED`.
5. **Процедура восстановления production** (решение владельца, с простоем):
   1. Остановить запись: frontend на страницу обслуживания / предыдущий deployment без checkout.
   2. Скачать объект по `backup_reference`, сверить SHA-256 зашифрованного файла, расшифровать `age -d`, сверить
      SHA-256 открытого `tar`.
   3. Предпочтительно — восстановление в **новый** Supabase-проект (`psql` по порядку `roles.sql`, `schema.sql`,
      `data.sql` с `session_replication_role = replica`, как в инструкции Supabase «Restore from dump»), проверки
      шага 6, затем переключение `VITE_SUPABASE_*`, Edge Functions и их секретов на новый проект. Если доступен
      PITR — сначала рассмотреть его (Dashboard → Database → PITR).
   4. Сверить `counts.json` и `migrations.json`; восстановить файлы Storage из `prod-storage/`.
   5. Release-smoke API против восстановленного проекта, затем вернуть frontend.
6. **Тестовое восстановление в отдельном проекте** (обязательно до первого релиза, затем не реже раза в 30 дней и
   после изменения процедуры; результат старше 30 дней снова открывает блокер):
   - цель — отдельный Supabase-проект `miniapp-restore-drill` (не production ref, без `supabase link` в этом
     репозитории) или disposable локальный стек с отдельным `project_id` и портами; никогда production;
   - шаги 5.2–5.4 на этой цели; проверки: оба SHA-256 совпали; `migration list` = manifest релиза;
     `count(*)` = `counts.json`; RLS: anon не читает `orders`;
   - журнал: дата, `backup_reference`, SHA релиза, результаты проверок, исполнитель. После проверки drill-проект
     и расшифрованные файлы удаляются.

Пока шаги 1–6 не выполнены, `backup_verified=true` означает только «оператор утверждает», а не «копия проверена».
