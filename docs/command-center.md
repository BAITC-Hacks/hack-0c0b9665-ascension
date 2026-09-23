# Ascension AI и карта города

`/command-center.html` открывает карту Астаны на весь экран. Панели конструктора, результатов, сравнения, сценариев и материалов открываются поверх карты. Существующие элементы интерфейса перемещаются вместе с обработчиками; расчёт по официальному набору остаётся единым.

Пользователь описывает план в Ascension AI. Сервер переводит намерение в допустимые меры и районы, проверяет ограничения и показывает предложение. Дополнительные меры ИИ помечаются отдельно. Кнопка применения снова проводит план через проверку приложения и официальный расчёт. Недоступность API не выдаётся за анализ ИИ.

После расчёта шкала времени показывает кварталы 0–8. Начало совпадает с исходным состоянием, конец — с официальным итогом. Промежуточные кадры используют учебную динамику с лагами и насыщением; подробности в [модели динамики](trajectory-model.md). Карта показывает географию OpenStreetMap, а районные показатели относятся к синтетическому набору кейса. Это не откалиброванный прогноз реальной Астаны.

## Подключение

Страница использует существующий `app.js`. После создания карты и всех вспомогательных панелей приложение условно подключает мост:

```js
if (document.body.dataset.commandCenter === 'true') {
  const { mountCommandCenterBridge } = await import('./command-center-bridge.js');
  const commandCenter = mountCommandCenterBridge({
    dataset, baseline, map: cityMap, applyDecisions, calculate,
    getContext: () => ({
      hasScenarioData: state.hasScenarioData,
      version: state.version,
      city: currentCity,
      resultValid: state.result?.valid === true,
      decisions: state.decisions.map(decision => ({ ...decision })),
    }),
  });
  panelDisposers.push(() => commandCenter.destroy());
}
```

Мост принимает только снимок контекста, не изменяет состояние приложения напрямую. `ascension:apply-plan` вызывает `applyDecisions`, затем `calculate`. Успешный `scenario:calculated` запрашивает `POST /api/trajectory`. Смена города, загрузка или изменение сценария отменяют запрос и делают старые кадры недействительными. `ascension:frame` выбирает кадр из последнего серверного ответа: содержимое произвольного события не подменяет результат карты.

`POST /api/plan` принимает только `{prompt}` длиной до 4000 символов и вызывает `proposePlan` через общий admission с `/api/explain`. `POST /api/trajectory` принимает только `{decisions}` и возвращает `simulateTrajectory`; оплата API не требуется. На обоих маршрутах сохраняются проверки метода, Origin, JSON и размера тела. Подробный контракт ИИ: [ascension-plan-contract.md](ascension-plan-contract.md).

## Проверка

```sh
node --test tests/trajectory.test.js tests/ai-admission.test.js tests/plan.test.js tests/command-center-bridge.test.js
```

Браузерная проверка: загрузить демо, рассчитать, переключить кварталы; изменить меру и убедиться, что старый просмотр недоступен; открыть конструктор, сравнение и таблицы; проверить узкий экран и reduced motion. Живой API-запрос выполняется только через сервер с уже настроенным ключом и общими ограничениями расходов.
