# Подключение уникальных иллюстраций

Небольшой комплект для владельца `operator-integration`: 25 разных прозрачных иконок и 3 фоновых WebP-файла (большой и мобильный варианты hero плюс текстура). API, маршруты, HTML и состояние приложения этот комплект не меняет. Изображения и CSS сами по себе ещё не подключены к интерфейсу.

## Порядок подключения

1. Подключить `/illustrations.css` **после** `/visual-design.css` и `/dashboard.css`. Файл дополняет существующие классы hero, метрик, карточек и сравнения, поэтому проверить итоговый каскад в интегрированном UI.
2. Импортировать карты из `/illustration-artwork.js`. Все значения — готовые абсолютные URL вида `/assets/illustrations/transport.webp`, повторно добавлять префикс не нужно. Manifest не меняет DOM и ничего не загружает до использования URL.
3. Сопоставлять картинку с `measure.id`, а не с направлением меры. При неизвестном ID оставить текстовую подпись без картинки: общий fallback снова создаст повторы. Район в датасете называется `esil`, его файл — `district-yesil.webp`.
4. Картинки декоративные: `alt=""`; подписи и числа оставить HTML. Задать `width`/`height` и `decoding="async"`; ниже первого экрана — `loading="lazy"`. Иконки не должны становиться единственными обозначениями кнопок/значений.

## Классы и размещение

- `.hero-art` — `<picture>` внутри `.hero`, рядом с `.hero-copy`. У `<source media="(max-width: 560px)">` использовать `backgroundArtwork.heroMobile`, у `<img>` — `backgroundArtwork.hero`, размеры 1536×1024, `fetchpriority="high"`. У picture — `aria-hidden="true"`. `.hero-copy` оборачивает существующий заголовок/описание/действия, не удаляя их ID и обработчики.
- `.metric-icon` — `<img>` внутри `.metric-label`/`.overview-card`, 56×56.
- `.direction-art` — `<img>` в `.measure-category`, 56×56. Категория остаётся текстом в `.direction-tag`; изображение обозначает конкретную меру.
- `.district-art` — `<img>` в `.district-heading`, 48×48. Разные районы используют разные изображения; в нескольких представлениях одного района сохраняется его идентичность.
- `.empty-plan-art` — `<img>` в `.empty-plan`, 92×92.
- `.result-placeholder-art` — `<img>` в `.result-placeholder`, 104×104.
- `city-texture.webp` уже подключена CSS как фон `.result-placeholder` и `.method-section`. Это декор, не географическая карта.

## Точные соответствия

`measureArtwork` — 14 мер:

- M1 → `transport.webp`; M2 → `traffic-lights.webp`; M3 → `light-rail.webp`.
- M4 → `ecology.webp`; M5 → `clean-heating.webp`; M6 → `green-belt.webp`.
- M7 → `school.webp`; M8 → `clinic.webp`; M9 → `sports.webp`.
- M10 → `safety.webp`; M11 → `safe-crossing.webp`; M12 → `digital-service.webp`.
- M13 → `utilities.webp`; M14 → `emergency-crew.webp`.

`districtArtwork` — 5 районов: `esil` → `district-yesil.webp`; `almaty` → `district-almaty.webp`; `saryarka` → `district-saryarka.webp`; `baikonur` → `district-baikonur.webp`; `nura` → `district-nura.webp`.

`metricArtwork` — 4 показателя: `baselineScore` → `services.webp`; `budgetTotal` → `budget.webp`; `budgetRemaining` → `budget-remaining.webp`; `decisionCount` → `decision-checklist.webp`.

`emptyStateArtwork` — 2 пустых состояния: `plan` → `plan.webp`; `results` → `people.webp`.

`backgroundArtwork` — 3 файла: `hero` → `city-hero.webp`; `heroMobile` → `city-hero-mobile.webp`; `texture` → `city-texture.webp`.

Все 25 иконочных слотов используют разные имена и разные SHA-256 содержимого. Исторический первоначальный расклад в `generated-artwork.md` заменён этим manifest и `unique-artwork.md`; повторяющиеся назначения из первой генерации не переносить.

## Проверка после интеграции

Проверить все 14 мер, 5 районов, 4 показателя, 2 пустых состояния и hero. В Network не должно быть 404; скрытые/открытые панели и переходы должны сохранять поведение. На 320, 390, 645 и 1440 px проверить текст, перенос заголовка Сарыарки, отсутствие горизонтального overflow, обрезку hero и контраст. CSS уже содержит исправление `.district-heading` при ширине до 360 px. Повторное использование одной иконки для того же района в другой вкладке допустимо; разные сущности не должны получать одинаковый fallback.

Промпты и сведения о генерации: [исходный комплект](generated-artwork.md), [уникальные иконки](unique-artwork.md). Версия «GPT Images 2.5» инструментом не подтверждалась; использовался встроенный GPT Image.
