# Новый магазин: короткая процедура

Предполагается, что платформа уже развёрнута (SETUP.md): Supabase-проект с миграциями и функциями, frontend на домене,
общий бот. Исходники приложения **не меняются**, новый frontend-деплой **не нужен**.

> «6 минут» — ориентир для подготовленных материалов (логотип, список товаров). Его не замеряли на реальном hosted-проекте,
> поэтому время не гарантируется. Внешние шаги (ответ клиента, проверка юридического текста) сюда не входят.

Команды выполняются в shell оператора. Для hosted-проекта задайте `SUPABASE_URL`, `SUPABASE_ANON_KEY` и `SUPABASE_SERVICE_ROLE_KEY`
(см. `.env.example`), не сохраняя их в файлах репозитория.

1. **Создать tenant**
   ```bash
   pnpm tenant:new --slug cloud-nine --name "Cloud Nine"
   ```
2. **Заполнить** `tenants/cloud-nine/shop.config.json`: описание, `theme` (11 цветов `#RRGGBB`, `mode`, `radius`), `currency`,
   `legalNotice`, `shopInformation`, `initialCategories`, при желании `initialProducts` с `variants` (вкус/цвет, `priceMinor`
   в копейках, `stock`). Логотип и фото положите в `tenants/cloud-nine/assets/` (PNG/JPEG/WebP, до 5 МБ, от 128 px).
3. **Проверить**
   ```bash
   pnpm tenant:validate --slug cloud-nine
   ```
   Ошибки и предупреждения (в том числе низкий контраст) исправьте до продолжения.
4. **Импортировать** (магазин создаётся в режиме preview и снаружи не виден):
   ```bash
   pnpm tenant:seed --slug cloud-nine
   ```
   Повторный запуск безопасен: дубликатов не будет, правки владельца не перезаписываются, новые позиции из конфига добавляются.
5. **Назначить владельца**
   ```bash
   pnpm owner:add --slug cloud-nine --email owner@cloud-nine.example
   ```
   Временный пароль передайте защищённым каналом. Владелец входит на `https://<домен>/admin`, проверяет витрину
   (в preview она видна только ему) и правит товары, цены, остатки, фото и палитру.
6. **Опубликовать**
   ```bash
   pnpm tenant:publish --slug cloud-nine --yes
   pnpm tenant:verify --slug cloud-nine --app-url https://<домен>
   ```
7. **Отдать клиенту ссылку**: `https://t.me/<bot>/<short_name>?startapp=cloud-nine`
   (выводится командой `tenant:verify`, если в конфиге заполнен блок `telegram`). Веб-ссылка: `https://<домен>/s/cloud-nine/`.

Ранее созданные магазины этот процесс не затрагивает: у каждого свой `shop_id`, свои данные и Storage-папка.
