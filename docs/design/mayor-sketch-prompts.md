# Эскизы рабочего пространства Ascension

Два самостоятельных визуальных ориентира для многостраничного интерфейса. Размер каждого — 1536 × 1024 px. Это эскизы: показатели и состав мер иллюстративны, фотографии не являются картографическим источником. Подпись о синтетических данных включена в оба изображения.

## Файлы

- `mayor-overview-sketch.png` — обзор города, навигация, панорама, метрики и таблица районов.
- `mayor-scenarios-sketch.png` — выбор мер, бюджет плана, пошаговая навигация и пример результата.

## Визуальная система

Тёплый светлый фон `#f5f5f0`, тёмная хвойная навигация `#173f35`, текст `#19352d`, тонкие шалфейные разделители и небольшие золотистые акценты. Умеренные скругления, открытая композиция, читаемые числовые показатели и чёткая иерархия русскоязычных заголовков.

## Проверка

Оба изображения просмотрены целиком. Навигация включает все восемь разделов. На обзоре читаются 52,56, 5 районов, 100 у.е. и 8 кварталов. На сценарии читаются 95 / 100, 56,54 и +3,98; пять сумм мер дают 95 у.е. Вёрстка и реальные данные при реализации должны браться из приложения; цифры районов в эскизе не заменяют исходный датасет. Иллюстративный знак в макетах не является утверждённым логотипом.

## Промпт: обзор

```text
Use case: ui-mockup.
Asset type: premium desktop civic decision workspace design mockup, 1536 x 1024 landscape, edge-to-edge interface with no browser chrome, no device frame.
Primary request: Create an exceptionally considered, realistic high-fidelity website screen for ASCENSION, a civic planning workspace for Kazakhstan mayors. It must feel designed by a highly skilled editorial product design team: calm authority, exquisite typographic hierarchy, useful readable data, subtle craft, disciplined alignment.
Scene: Overview page for Astana, with a 230px full-height deep pine sidebar on the left. Main canvas is warm off-white. Native-looking web UI, perfectly flat front-on screenshot, not perspective.
Color palette: warm off-white #f5f5f0, deep pine #173f35 sidebar and primary controls, dark #19352d typography, sage fine dividers, restrained warm gold accents, paper white table surfaces.
Typography: precise contemporary sans-serif with beautiful Cyrillic, strong editorial large heading, tabular numerals, comfortably readable small text.
Layout:
1. Sidebar: small refined geometric civic emblem and ASCENSION wordmark at top, small subtitle "ПРОСТРАНСТВО РЕШЕНИЙ". Clean single-line navigation with thin outline icons, generous spacing: "Обзор" selected in a lighter pine block, "Карта города", "Сценарии", "Районы", "Обращения", "Поручения", "Данные". At bottom small "Астана" and subtle "Учебная модель".
2. Main thin cream header at top: breadcrumb "Рабочее пространство / Обзор", city selector "Астана" on right and small circular profile with "АК".
3. Spacious content header below. Small uppercase eyebrow "ГОРОД В ЦИФРАХ", large beautifully set exact title "Город начинается с решений." with line break after "начинается" if useful. Subtitle exact "Астана · учебная модель". Compact dark pine CTA aligned right: "Новый сценарий" and thin plus icon.
4. A low wide editorial photograph panorama of central Astana with Baiterek and Ishim river, modern skyline, green embankment, soft warm daylight. Authentic refined architectural photography, naturally cropped wide about 125px tall. Small overlaid lower-left white caption "Астана" only. The image is part of UI, not the whole backdrop.
5. Four beautifully spaced horizontal metric columns, separated by fine sage rules: "Индекс развития" value "52,56"; "Районы в модели" value "5"; "Бюджет сценария" value "100 у.е."; "Горизонт планирования" value "8 кварталов". Small restrained supporting microcopy, no invented live indicators.
6. Lower main section: left about 65 percent width "Районы города", tiny "Учебные показатели" and table with column names "Район", "Индекс", "Приоритет". Five neat rows "Алматы" value "54,2" tag "Транспорт"; "Сарыарка" "49,8" tag "Среда"; "Есиль" "58,1" tag "Инфраструктура"; "Байқоңыр" "48,6" tag "Социальная сфера"; "Нұра" "52,1" tag "Благоустройство". Beside each index show elegant muted green horizontal bar, no fake detailed graphs. Rounded tags very subtle.
7. Lower right sidebar column aligned to table: "Следующее решение" panel with tiny gold "01", heading "Сравните два пути развития", brief copy "Соберите меры и оцените изменения по районам.", clear text link "Открыть сценарии →". Below small two-line "Данные для моделирования" with indicator "Синтетические данные".
8. Tiny discreet footer "Эскиз интерфейса · синтетические данные".
Constraints: exact readable Russian headings, sensible Cyrillic, no misspellings, consistent 8px spacing rhythm, minimal 4-8px corner radii, accessible contrast, not overly rounded cards. Screen is explicitly a design mockup with illustrative synthetic figures, no claim of live government data. The 52,56 baseline and all four primary metrics must be exactly visible.
Avoid: purple, saturated gradients, glassmorphism, glowing effects, gratuitous card grids, floating blobs, cartoon buildings, giant 3D objects, decorative abstract charts, dense unreadable text, stock SaaS visual clichés, watermarks, attribution credits.
```

## Промпт: сценарий

```text
Use case: ui-mockup.
Asset type: premium desktop civic decision workspace design mockup, 1536 x 1024 landscape, edge-to-edge interface with no browser chrome, no device frame.
Primary request: Create an exceptionally considered high-fidelity website screen for ASCENSION, a civic planning workspace for Kazakhstan mayors. This is the "Сценарии" page of a coherent premium city management product. It must feel like meticulous human editorial product design: calm authority, useful information density, exquisite alignment, clear planning flow.
Scene: Scenario planning workspace for Astana. 230px full-height deep pine sidebar on the left, warm off-white main canvas, cream top header. Native-looking flat front-on website screenshot.
Color palette: warm off-white #f5f5f0, deep pine #173f35 sidebar and primary buttons, dark #19352d typography, sage fine dividers, tiny warm gold accents. Paper white surfaces, subtle gray-green disabled elements. No dramatic shadows.
Typography: contemporary sans-serif with excellent readable Cyrillic, bold but refined heading, tabular numerals, spacious line-height, small uppercase eyebrow labels.
Layout:
1. Sidebar: a fine warm gold line icon of a tall civic monument/flower, ASCENSION spaced wordmark beneath it, tiny subtitle "ПРОСТРАНСТВО РЕШЕНИЙ". Single-line navigation with thin outline icons: "Обзор", "Карта города", "Сценарии" selected in lighter pine, "Районы", "Обращения", "Поручения", "Данные". Bottom "Астана" and "Учебная модель".
2. Thin top header: breadcrumb "Рабочее пространство / Сценарии", right "Астана" city selector, small circular profile "АК".
3. Main header: eyebrow "ПЛАНИРОВАНИЕ", large exact heading "Сценарий развития", brief subtitle "Выберите меры и оцените их влияние на город." On right quiet outlined button "Сохранить сценарий". Below, elegantly spaced horizontal stepper: gold circle "01" + "Приоритеты", active pine circle "02" + "Решения", subtle circle "03" + "Результат". Fine connector lines.
4. Main work area two columns, left about 65 percent, right about 30 percent. Left section title "Меры для города" with small "5 решений в плане". Category filter chips on one row: "Все меры" selected pine, "Транспорт", "Экология", "Социальная сфера", "Инфраструктура". Use neat compact shapes not pills everywhere.
5. Below filters, well-aligned white measure cards in one full-width vertical column, not a mosaic. First card: tiny eyebrow "ТРАНСПОРТ", small fine-line bus icon on pale sage square, title "Выделенные полосы для автобусов", body "Быстрее ежедневные поездки. Доступнее районы.", bottom "25 у.е." and "4 квартала", restrained tag "В плане ✓". Second card: tiny "ГОРОДСКАЯ СРЕДА", small fine-line leaf icon, title "Зелёные пространства рядом с домом", body "Новые места отдыха и комфортные улицы.", bottom "20 у.е." and "3 квартала", tag "В плане ✓". Third more compact row "Обновление инженерных сетей", "20 у.е.", quiet "Подробнее →". Keep all copy readable and not crowded. Use hairline sage dividers and 6px corner radii.
6. Right sticky plan panel with thin sage border: title "Ваш план", small "5 решений". Large budget exact "95 / 100" with small "у.е." below. Elegant horizontal pine budget bar 95 percent full and small gold remaining segment. Copy "Осталось 5 у.е.". Five compact plan rows with small checkmark, title and right amount: "Автобусные полосы" 25; "Зелёные пространства" 20; "Инженерные сети" 20; "Доступная среда" 15; "Уличное освещение" 15. Subtle divider then large primary pine full-width button "Рассчитать сценарий →". Below small note "Горизонт: 8 кварталов".
7. At bottom across main content, tasteful pale-sage results strip, heading "Ожидаемый результат" plus small chip "Пример расчёта". Left metric "Индекс развития" large exact "56,54". Center fine vertical divider, large exact "+3,98" with caption "к базовому индексу 52,56". Right tiny simple upward line chart in pine and a text link "Сравнить сценарии →". No exaggerated live claims.
8. Very small clear footer "Эскиз интерфейса · синтетические данные". The result is illustrative, not an actual current government forecast.
Constraints: follow exact specified main numbers 95 / 100, 56,54, +3,98, 52,56 and 8 quarters. Clear readable Cyrillic, meticulously balanced whitespace, accessible contrast, calm credible governmental planning tool. No photo needed on this page. The labels must be real meaningful Russian words. Every UI block fits within the frame.
Avoid: purple, saturated gradients, glassmorphism, neon, floating blobs, gratuitous rounded cards, smartphone frames, dark mode main canvas, giant 3D decorations, jargon nonsense, extra charts, watermarks, tool credits, AI attribution.
```
