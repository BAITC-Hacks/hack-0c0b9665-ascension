# Telegram и обращения в Cloudflare

Модуль `src/complaints-worker/` подключается к тому же Worker, что и сайт. Веб-форма и Telegram используют одно постоянное хранилище и те же правила, что локальный Node-сервер. Адреса остаются `/citizens.html`, `/mayor.html`, `/api/citizen/config`, `/api/complaints*` и `/api/telegram/webhook`.

## Подключение к Worker

В `src/worker.js` импортировать `routeComplaintRequest` из `./complaints-worker/http.js`. После проверки пути, перед общим отказом для неизвестного API:

```js
const complaintResponse = await routeComplaintRequest(request, env);
if (complaintResponse) return complaintResponse;
```

В `src/cloudflare.js` экспортировать класс:

```js
export { ComplaintService } from './complaints-worker/durable.js';
```

В существующую конфигурацию Wrangler добавить `nodejs_compat` в `compatibility_flags`, binding `{ "name": "COMPLAINTS", "class_name": "ComplaintService" }` в `durable_objects.bindings` и **новую** миграцию `{ "tag": "v2-complaints", "new_sqlite_classes": ["ComplaintService"] }`. Существующую миграцию `AIBudget` сохранять: это отдельный постоянный счётчик AI, его нельзя пересоздавать. SQLite-backed Durable Objects поддерживают используемый транзакционный KV API: [документация хранилища](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

Несекретные переменные: `TELEGRAM_BOT_USERNAME` без `@`, `PUBLIC_BASE_URL` — свой HTTPS origin. Необязательный `TELEGRAM_SUPPORT_URL` — контакт поддержки. Секреты `ADMIN_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` добавляются только через Cloudflare Secrets, например `npx --yes wrangler@4.136.3 secret put ADMIN_TOKEN`. Не вставлять значения в команды, конфигурацию Git или исходники. `OPENAI_API_KEY` для обращений и Telegram не нужен; классификация остаётся системой правил.

Перед публикацией выполнить `npm test` и `npx --yes wrangler@4.136.3 deploy --dry-run`. После публикации проверить публичный `/api/citizen/config`, отказ `401` для `GET /api/complaints` без ключа и открытие обеих страниц. Затем из локального окружения с секретами **этого бота**:

```sh
npm run bot:webhook -- info
npm run bot:setup
npm run bot:webhook -- set
npm run bot:webhook -- info
```

`set` проверяет готовность сервера, совпадение username, наличие защиты панели и секрет webhook до изменения Telegram. Очередь ожидающих обновлений сохраняется, число одновременных доставок — одно. Сначала остановить прежний polling у владельца бота; зарегистрированный webhook затем исключает polling через Telegram API. [Telegram webhook](https://core.telegram.org/bots/api#setwebhook).

## Хранение и перезапуски

Один Durable Object `city-complaints` сериализует операции. Принятые обращения сохраняются отдельными ключами, включая личные квитанции и историю. Дедупликация отправки по `update_id` сохраняется вместе с обращением. Облачные черновики, шаг меню и подготовленный ответ также сохраняются; TTL черновика — 30 минут. Журнал доставки отдельных обновлений живёт 24 часа и очищается alarm. После аварии на границе отправки ответа Telegram возможен повтор ответа, но повтор принятого `/send` не создаёт новое обращение.

Панель всегда требует `X-Admin-Token`: облачного обхода «локальное демо» нет. Трекинг не раскрывает текст, адрес, координаты, фотографии и Telegram ID. Публичная форма и трекинг имеют общий постоянный предел 60 запросов за минуту; ограничение не доверяет заголовкам IP. Фото доступны только защищённой панели через ограниченный прокси Telegram.

Для MVP используются выборка и классификация всех обращений; при росте объёма нужен индексированный поиск и пагинация. Личные аккаунты сотрудников и производственный регламент обработки обращений не входят в этот модуль. Локальные файлы и облачное хранилище независимы: данные с компьютера Данияра автоматически не переносятся. Не публикуйте реальные обращения для проверки — используйте явно учебный текст.

## Воспроизводимая проверка

- `node --test tests/complaints-worker.test.js tests/complaints-durable.test.js tests/telegram.test.js tests/telegram-webhook.test.js`: серверная защита, постоянные квитанции, отказ записи, диалог с перезапуском между сообщениями и повторная доставка. Telegram-транспорт подставной.
- `npm run test:self-host`: настоящий Node-процесс, чистая временная копия, расчёт, обращение, защищённое решение и сохранение после перезапуска; без ключей и внешних запросов.
- `npx --yes wrangler@4.136.3 dev --local`: локальный workerd с постоянной эмуляцией SQLite DO; проверять учебную квитанцию после остановки и нового запуска.

Реальный чат проверяется после регистрации: `/start` → согласие → учебное обращение → `/send`, затем решение в защищённой панели и проверка статуса. Успех автоматических тестов сам по себе не подтверждает реальную доставку Telegram.

Полный самостоятельный запуск Node, Docker и systemd: [инструкция организатору](self-hosting.md).
