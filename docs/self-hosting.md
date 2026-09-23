# Локальная проверка и собственный сервер

Организаторы могут запустить симулятор, формы жителей и панель акима на своём компьютере с **Node.js 24+**, без npm-зависимостей, API-ключей, подписок и аккаунтов участников. Для Telegram нужен свой бот, созданный через BotFather; для живого AI — свой серверный ключ. Эти интеграции необязательны для проверки расчёта и обращений.

## 1. Чистый запуск на Windows, Linux или macOS

Скачайте исходники выданного репозитория или клонируйте его с разрешённым организаторами доступом:

```sh
git clone https://github.com/BAITC-Hacks/hack-0c0b9665-ascension.git
cd hack-0c0b9665-ascension
node --version
npm start
```

Установка `npm install` не нужна. Откройте:

| Адрес | Проверка |
| --- | --- |
| `http://127.0.0.1:3000/` | Симулятор и официальный пример: стоимость 95, Score 56.54307 |
| `http://127.0.0.1:3000/citizens.html` | Создание обращения, номер и личный код проверки |
| `http://127.0.0.1:3000/mayor.html` | Назначение службы, статус и публичное решение |
| `http://127.0.0.1:3000/api/health` | `ok: true`; без ключа `aiConfigured: false` |

Остановите сервер Ctrl+C, запустите снова и проверьте обращение по исходным номеру и коду. Оно сохраняется в `var/complaints.json`; этот файл находится вне `public/` и исключён из Git. В чистом локальном режиме панель доступна без пароля только при обращении с loopback к `localhost` или `127.0.0.1`.

Если порт занят, создайте `.env.local` с `PORT=3100`, затем снова выполните `npm start`. При необходимости скопируйте `.env.example` в `.env.local` и заполните только используемые поля. Не заменяйте уже настроенный файл. Переменные процесса имеют приоритет над `.env.local`: [документация Node.js](https://nodejs.org/docs/latest-v24.x/api/cli.html#--env-filefile).

Из второго терминала в корне репозитория:

```sh
npm test
node scripts/self-host-smoke.js
```

Последняя команда создаёт временную копию runtime-файлов, запускает настоящий `src/server.js` на свободном порту, проверяет расчёт, пояснение без модели, приём обращения, защищённую панель, квитанцию и сохранность после реального перезапуска процесса. Она не читает `.env.local`, не вызывает Telegram/AI, не меняет рабочий `var/` и удаляет синтетические данные после проверки. Успешный результат содержит `"ok": true`.

## 2. Что работает без внешних сервисов

| Функция | Условия |
| --- | --- |
| Данные кейса, проверка пяти мер, Score, сравнение сценариев | Локальный сервер; облачные сервисы не нужны |
| Расчётное пояснение и проверенные локальные замены | Без ключа; интерфейс честно указывает, что это не LLM |
| Веб-обращения, правила классификации, панель, квитанции | Локальный JSON-файл; классификация обращений остаётся системой правил и при подключённом AI симулятора |
| Географическая подложка, 3D-здания, поиск адресов | Нужен интернет: OpenFreeMap/OpenStreetMap и Photon; без сети карта и поиск недоступны, расчётное API продолжает работать |
| Telegram, фото и уведомления в чате | Интернет и собственный `TELEGRAM_BOT_TOKEN`; без токена веб-форма работает |
| AI-анализ симулятора | Интернет и `OPENAI_API_KEY` на сервере; при отсутствии или ошибке ключа сохраняются расчёт и явно отмеченное расчётное пояснение |

MapLibre включён в исходники, но внешние географические тайлы не включены. Сценарии A/B находятся в памяти страницы до её перезагрузки. Telegram-черновики находятся в памяти сервера до 30 минут и теряются при его перезапуске; принятые обращения и квитанции сохраняются.

## 3. Постоянный сервер Linux с systemd

Подходит собственный Linux-сервер с Node.js 24+, постоянным диском и systemd. Установите код в `/opt/ascension` (тот же репозиторий, без локальных секретов и рабочего `var/`). Один процесс `src/server.js` обслуживает и сайт, и обращения. Для JSON-хранилища не применяются несколько экземпляров, кластер Node или несколько серверов с одним общим файлом.

На новом сервере создайте отдельного служебного пользователя и защищённую конфигурацию:

```sh
sudo useradd --system --home /opt/ascension --shell /usr/sbin/nologin ascension
cd /opt/ascension
sudo install -m 600 .env.example /etc/ascension.env
sudoedit /etc/ascension.env
```

Если пользователь или конфигурация уже существуют, используйте их; команду `install` для существующего файла с секретами не повторяйте. В `/etc/ascension.env` задайте:

```dotenv
HOST=127.0.0.1
PORT=3000
COMPLAINTS_FILE=/var/lib/ascension/complaints.json
ADMIN_TOKEN=YOUR_OWN_RANDOM_ADMIN_SECRET
PUBLIC_BASE_URL=https://city.example.com
BOT_SERVER_URL=http://127.0.0.1:3000
OPENAI_API_KEY=
```

Замените `YOUR_OWN_RANDOM_ADMIN_SECRET` на собственное случайное значение и `city.example.com` на свой домен. Случайное значение можно получить локально командой `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Вводите его в панель акима; браузер хранит ключ только до перезагрузки страницы. Остальные необязательные переменные можно оставить пустыми.

В шаблонах путь к Node — `/usr/bin/node`. Проверьте `command -v node`; при отличии исправьте `ExecStart` в обоих файлах `deploy/*.service` на абсолютный путь к Node 24+. Код должен читаться пользователем `ascension`; размещение под домашним каталогом пользователя не подходит для этих шаблонов.

```sh
sudo install -m 644 deploy/ascension.service /etc/systemd/system/ascension.service
sudo install -m 644 deploy/ascension-bot.service /etc/systemd/system/ascension-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now ascension
sudo systemctl status ascension --no-pager
curl --fail http://127.0.0.1:3000/api/health
```

Служба поднимается после перезагрузки системы и перезапускается при аварийном завершении. `StateDirectory` создаёт `/var/lib/ascension` с владельцем `ascension`; этот каталог остаётся при перезапуске и обновлении исходников. Не меняйте `COMPLAINTS_FILE` в этой конфигурации: остальные каталоги доступны службе только для чтения. Поведение директив описано в [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) и [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).

После изменения `/etc/ascension.env` выполните `sudo systemctl restart ascension`; при активном polling также `sudo systemctl restart ascension-bot`. Диагностика: `sudo journalctl -u ascension -u ascension-bot -n 50 --no-pager`. HTTP `/api/health` проверяет живость процесса, но не заменяет создание и повторную проверку синтетического обращения.

### HTTPS через Caddy

Для публичного сайта установите Caddy, направьте DNS своего домена на сервер и откройте порты 80/443. Замените домен в `deploy/Caddyfile`, добавьте этот блок в существующую конфигурацию Caddy, проверьте и перезагрузите её:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Шаблон проксирует сайт на `127.0.0.1:3000` и сохраняет исходный `Host`; не подменяйте его на `localhost`. Node остаётся доступен только локально, публичный вход проходит через HTTPS. Автоматическое получение сертификата требует корректного DNS и доступности портов: [Caddy reverse proxy](https://caddyserver.com/docs/quick-starts/reverse-proxy/).

### Резервная копия и обновление

Перед обновлением остановите polling, если он включён, затем веб-службу. Скопируйте `/var/lib/ascension/complaints.json` в защищённое место вне репозитория и `public/`; сохраните также `/etc/ascension.env` отдельно с ограниченным доступом. Обновите исходники, выполните `npm test` и `node scripts/self-host-smoke.js`, затем запустите веб-службу и выбранный Telegram-режим. При восстановлении используйте резервную копию с владельцем `ascension`, правами `600` и остановленной службой. Не удаляйте файл при ошибке чтения: сервер сообщает о повреждении без его перезаписи.

## 4. Docker Compose — дополнительный вариант

Нужны Docker Engine с работающим daemon и Docker Compose 2.17+. Для первой сборки требуется получить образ Node 24. Node и npm на хосте для запуска контейнера не нужны. Скопируйте `.env.example` в `.env.local`, задайте собственный непустой `ADMIN_TOKEN`, затем:

```sh
docker compose --env-file .env.local up -d --build
docker compose --env-file .env.local ps
```

Откройте `http://127.0.0.1:3000`; панель акима потребует `ADMIN_TOKEN` и при локальном доступе через контейнер. Compose не запустится с пустым токеном. Для другого порта добавьте `APP_PORT=3100` в `.env.local`; внутренний порт остаётся 3000. Для публичного сайта используйте Caddy на хосте из предыдущего раздела, при смене `APP_PORT` исправьте порт прокси. Статика, сервер и данные кейса входят в образ; `.env.local` и обращения исключены из контекста сборки.

Контейнер работает пользователем `node`; JSON хранится в постоянном named volume `complaints`, смонтированном в `/app/var`. Пересоздание контейнера и `docker compose down` сохраняют volume. **`down -v` удаляет обращения.** Не запускайте несколько экземпляров `app` с этим volume. Политика `restart: unless-stopped` возобновляет контейнер после аварии процесса и запуска Docker daemon; `healthcheck` показывает состояние, но сам по себе не перезапускает зависший процесс.

После изменения окружения примените `docker compose --env-file .env.local up -d --force-recreate`; простой `restart` не загружает новую конфигурацию. Если включён polling, добавьте к этой команде `--profile telegram` перед `up`, чтобы согласованно пересоздать оба контейнера.

Для резервной копии остановите `app` и `bot`, скопируйте `/app/var/complaints.json` из остановленного `app` командой `docker compose --env-file .env.local cp app:/app/var/complaints.json ./complaints-backup.json`, перенесите копию в защищённое место вне репозитория, затем запустите выбранные службы. Копия содержит данные обращений; не добавляйте её в Git. Создайте первое учебное обращение перед проверкой резервного копирования — пустой сервер ещё не создаёт JSON.

Синтаксис: [Compose services](https://docs.docker.com/reference/compose-file/services/), [профили](https://docs.docker.com/compose/how-tos/profiles/), [перезапуск и изменения конфигурации](https://docs.docker.com/reference/cli/docker/compose/restart/).

## 5. Собственный Telegram-бот

Создайте отдельного тестового бота через [BotFather](https://t.me/BotFather). В `.env.local` для Node/Docker или `/etc/ascension.env` для systemd заполните `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` без `@`, собственный случайный `TELEGRAM_WEBHOOK_SECRET` (латинские буквы, цифры, `_`, `-`) и при наличии публичного сайта `PUBLIC_BASE_URL`. Бот-токен нужен обоим процессам в polling-режиме. Не используйте токен команды для независимой проверки: один бот должен обслуживаться только одной выбранной инсталляцией.

Для локального polling оставьте `PUBLIC_BASE_URL` пустым или укажите адрес именно локальной инсталляции. Облачное DO-хранилище и локальный JSON независимы: ссылка на облачный сайт не сможет найти локальную квитанцию. `http://127.0.0.1` открывается только на компьютере с сервером, не на телефоне жителя. Для облачного варианта с постоянными черновиками см. [Telegram в Cloudflare](telegram-cloudflare.md).

Если владелец переносит один бот между облаком и своим компьютером: остановить прежний polling, выполнить `bot:webhook -- delete`, запустить локальный сервер и единственный `npm run bot`. Для возвращения в облако остановить локальный polling (Ctrl+C), восстановить облачный `PUBLIC_BASE_URL` и выполнить `bot:webhook -- set`. Не запускайте оба режима параллельно; уже принятые обращения остаются в хранилище той инсталляции, где они были созданы.

### Polling — работает без публичного адреса

Перезапустите веб-сервер после настройки переменных. В другом терминале того же проекта:

```sh
npm run bot:webhook -- info
# Только если зарегистрирован webhook этого тестового бота:
npm run bot:webhook -- delete
npm run bot
```

`BOT_SERVER_URL` должен указывать на уже работающий сервер: по умолчанию `http://127.0.0.1:3000`; исправьте при другом `PORT`. Оба процесса должны оставаться включёнными. Polling читает Telegram и передаёт события HTTP-серверу; только веб-сервер записывает JSON. Для Linux-служб включите `sudo systemctl enable --now ascension-bot`. Команды webhook с серверным env-файлом выполняются через `sudo node --env-file=/etc/ascension.env /opt/ascension/src/telegram-webhook.js info` (или `delete`), без вывода значений секретов.

Для Docker после отключения webhook собственного бота:

```sh
docker compose --env-file .env.local --profile telegram up -d --build
```

Контейнер `bot` делит сеть с `app` и обращается к нему через loopback. Он не монтирует volume обращений. Команды настройки из уже запущенного контейнера доступны без Node на хосте: `docker compose --env-file .env.local exec app node src/telegram-webhook.js info` (или `delete`).

### Webhook — для постоянного HTTPS-сервера

Остановите polling этого бота (`sudo systemctl disable --now ascension-bot` для systemd либо `docker compose --env-file .env.local --profile telegram stop bot`). Убедитесь, что публичный HTTPS-адрес открывается и `ADMIN_TOKEN` настроен. Из Node-проекта со своими переменными:

```sh
npm run bot:webhook -- set
npm run bot:webhook -- info
```

Для systemd используйте `sudo node --env-file=/etc/ascension.env /opt/ascension/src/telegram-webhook.js set`; для Docker — `docker compose --env-file .env.local exec app node src/telegram-webhook.js set`. Helper регистрирует `${PUBLIC_BASE_URL}/api/telegram/webhook`, передаёт Telegram секрет для заголовка `X-Telegram-Bot-Api-Secret-Token` и сохраняет ожидающие обновления. Это реальное изменение настроек выбранного бота. Polling и webhook одновременно не используются: [Telegram Bot API](https://core.telegram.org/bots/api#getupdates), [setWebhook](https://core.telegram.org/bots/api#setwebhook).

Проверка своим Telegram-аккаунтом: `/start` → `/agree` → учебный текст → `/address Учебная улица 42` → `/send`. Сохраните номер и код, измените статус и решение в панели, проверьте уведомление и `/status НОМЕР` в том же чате. На сайте для проверки нужны номер и личный код. Фото остаётся ссылкой на файл Telegram и требует его доступности. Telegram не работает полностью офлайн; синтетические тесты `npm test` проверяют обработчик без реальных отправок.

## Результат проверки этой инструкции

23 сентября 2026 на Windows с Node.js **v24.19.0** выполнен `node scripts/self-host-smoke.js`: чистый запуск без ключей, три страницы, официальный расчёт, расчётное пояснение, обращение и защищённая панель, квитанция и сохранность после перезапуска — успешно. Использовалась временная копия runtime-файлов, рабочие секреты и обращения не читались. Docker daemon, systemd и Caddy в этой среде не запускались; их файлы являются готовыми шаблонами для проверки на сервере организаторов. Живой Telegram проверяется отдельно после настройки собственного бота.
