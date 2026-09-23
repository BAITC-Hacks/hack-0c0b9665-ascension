# Обращения жителей: контракт реализации

База: `origin/main 6fcc4cb`. Ветка `feat/citizen-ideas-daniyar`. Отдельное расширение существующего симулятора; официальный датасет и расчётное ядро не меняются.

## Владение файлами

- Агент storage: `src/complaints/store.js`, `src/complaints/classify.js`, `tests/complaints-store.test.js`.
- Агент UI: `public/citizens.html`, `public/mayor.html`, `public/citizen.css`, `public/citizen.js`, `public/mayor.js`.
- Агент Telegram: `src/complaints/telegram.js`, `src/telegram-poll.js`, `tests/telegram.test.js`.
- Координатор: HTTP-интеграция, сквозные тесты, запуск, документация, ссылки навигации.

## HTTP

- `GET /api/citizen/config` → `{telegramUrl, analysisMode:'rules', adminConfigured, demoMode}`.
- `POST /api/complaints` с `{text,address?,districtId?,location?:{lat,lon},consent:true}` → 201 `{complaint,trackingToken}`. `complaint` — публичное представление без текста, адреса, координат, вложений, Telegram ID и токена.
- `POST /api/complaints/track` с `{id,trackingToken}` → `{complaint}` с тем же публичным представлением, историей и публичным решением. Неверная пара → 404.
- `GET /api/complaints?status=&priority=&districtId=&category=&q=` → `{complaints,stats}` для панели акима.
- `PATCH /api/complaints/:id` с `{status?,assignee?,resolution?,priority?,category?,summary?,reason?,duplicateOf?,expectedUpdatedAt?}` → `{complaint,notification:{state}}`. Панель передаёт версию `expectedUpdatedAt`; конфликт с новым решением другого сотрудника → 409. Статусы: `new`, `in_progress`, `resolved`, `rejected`. Для закрытия обязательно решение. Статус/назначение/решение и исправления анализа записываются в историю.
- `POST /api/telegram/webhook`: Telegram Update; секрет заголовка `X-Telegram-Bot-Api-Secret-Token` обязателен. Повтор `update_id` не создаёт дубль.
- Административные запросы используют `X-Admin-Token`. Без настроенного токена допускается только локальное демо с loopback-соединением. При удалённом доступе — отказ. Публичный трекинг не раскрывает исходную жалобу и данные отправителя.

## Внутренний контракт

`createComplaintStore({filePath})` возвращает объект с async методами `create(input)`, `list(filters)`, `get(id)`, `track(id,trackingToken)`, `update(id,patch)`. `create` возвращает `{complaint,trackingToken,duplicateUpdate:false|true}`; для Telegram вход дополнительно содержит `source:'telegram'`, `telegramChatId`, `telegramUpdateId`, `attachments:[{fileId,fileUniqueId?,type:'photo'}]`. Повтор update возвращает прежнюю квитанцию. `get` — приватное представление только для серверных модулей. `toAdminComplaint(record)` скрывает trackingToken/chat IDs/file IDs; `toPublicComplaint(record)` скрывает также текст/адрес/геолокацию/вложения. Ошибки имеют `status`, `code`, `message`.

Запись: `{id,text,address,districtId,location,source,attachments,analysis:{mode:'rules',category,summary,priority,reason,duplicateOf},status,assignee,resolution,createdAt,updatedAt,history:[{status,assignee,resolution,at}],trackingToken,telegramChatId?,telegramUpdateId?}`. Приоритеты: `high`, `normal`, `low`. Районы: `esil`, `almaty`, `saryarka`, `baikonur`, `nura`; допустим пустой. Категории: `roads`, `utilities`, `waste`, `lighting`, `safety`, `other`. Локальные правила явно обозначаются как правила, а не подтверждённый ИИ.

`createTelegramProcessor({store,sendMessage,publicBaseUrl})` возвращает async `processUpdate(update)`; `createTelegramTransport({token,fetchImpl?})` возвращает `sendMessage(chatId,text)`, `getUpdates(offset)`, `getPhoto(fileId)`. По умолчанию без токена ничего не отправляется. CLI polling запускается отдельно по явной команде. Для проверки — только подставной транспорт и синтетические данные.

Хранилище — `var/complaints.json` вне `public`, исключено из Git. Веб-форма просит согласие на обработку обращения; публичная карта не создаётся. Панель акима содержит список, фильтры и схематическую карту с явным обозначением. Геолокация необязательна; отсутствие точки показывается явно. Никакие настоящие обращения и ключи при разработке не отправляются внешним сервисам.
