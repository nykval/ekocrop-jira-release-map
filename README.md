# Карта релизов EkoCrop — GitHub Pages и Cloudflare Worker

**[Открыть сайт](https://nykval.github.io/ekocrop-jira-release-map/)** — адрес остаётся на GitHub Pages, включая форму входа.

Веб-приложение: базовый снимок задач хранится в CSV внутри репозитория, а Cloudflare Worker может принимать изменения из Jira Automation между ручными недельными выгрузками. Для доступа к карте релизов нужен вход в аккаунт.

GitHub Pages показывает интерфейс и форму входа. Браузер обращается к Cloudflare Worker в фоне для проверки пароля, получения данных из Worker и изменения задач. Исходный CSV, встроенные в HTML данные и история Git в публичном репозитории остаются открытыми; форма входа ограничивает работу через интерфейс и защищает операции Worker, но не скрывает эти файлы.

## Публикация веб-приложения

GitHub хранит исходный код и CSV-базу. GitHub Pages публикует корневой `index.html`. Cloudflare Worker обслуживает API, проверяет вход и принимает callback Jira. Секрет `APP_PASSWORD` задаётся только в настройках Worker; почта единственного пользователя задана в `wrangler.jsonc` как `APP_EMAIL`. Пароль не записывается в репозиторий. После входа браузер хранит ключ сеанса в текущей вкладке и передаёт его Worker при запросах; ключ действителен до семи дней или до выхода.

## Еженедельная ручная выгрузка CSV

Раз в неделю замените один CSV-файл в проекте:

- `data/jira.csv` — полный экспорт всех задач Jira.
- `data/last-export.json` — дата и счетчики последней выгрузки.

Для GitHub Pages по адресу `https://nykval.github.io/ekocrop-jira-release-map/` достаточно корневой папки `data`.

После проверки входа приложение ищет `data/jira.csv`. Если файл найден, список релизов строится из колонки `Исправить в версиях`. Worker нужен для проверки входа и серверных действий.

### Формат `jira.csv`

Файл должен быть обычным полным CSV из Jira в таком формате:

```csv
Тема,Ключ проблемы,Идентификатор проблемы,Тип задачи,Статус,Ключ проекта,Название проекта,Тип проекта,Руководитель проекта,Описание проекта,URL проекта,Приоритет,Решение,Исполнитель,Автор,Создатель,Создано,Обновленo,Последний просмотр,Дата решения,Затронуты версии,Исправить в версиях,Исправить в версиях,Исправить в версиях,Компоненты,Компоненты,Компоненты,...
```

Обязательные колонки:

- `Ключ проблемы`
- `Тема`
- `Исправить в версиях`

Желательные колонки:

- `Тип задачи`
- `Статус`
- `Приоритет`
- `Исполнитель`
- `Компоненты`
- `Ссылка на эпик`
- колонки связей, где в названии есть `связ`, `ссылка на эпик` или `родительская ссылка`

Можно выгружать один общий CSV со всеми задачами и всеми релизами. При выборе релиза приложение возьмет из него только задачи нужного `fixVersion` и связанные проектные задачи.

### `last-export.json`

```json
{
  "exportedAt": "2026-08-18T06:13:00Z",
  "issuesCount": 286,
  "releasesCount": 42,
  "source": "manual jira csv export"
}
```

После замены файлов закоммитьте изменения и отправьте их в GitHub.

### Cloudflare

1. В Cloudflare откройте **Workers & Pages → Create → Import a repository** и выберите этот репозиторий.
2. Build command: `npm run deploy`. Для первого подключения можно использовать стандартные настройки Cloudflare Workers.
3. Создайте Workers KV namespace, например `ekocrop-jira-jobs`, и добавьте к Worker binding с именем `JOBS`.
4. Задайте секрет `APP_PASSWORD` и нажмите Deploy. Адрес Worker вида `https://ekocrop-jira-release-map.<поддомен>.workers.dev` используется страницей GitHub Pages для запросов API.

В `wrangler.jsonc` уже настроены Worker и API. После подключения GitHub обновления ветки `main` публикуются автоматически. GitHub Pages должен оставаться включённым.

### Обязательные параметры сервера

| Переменная | Назначение |
|---|---|
| `JIRA_BASE_URL` | Адрес Jira для ссылок и REST API |

Список релизов формируется динамически из значений `fixVersion` формата `EkoCrop …`.

KV постоянно хранит последний успешно принятый снимок каждого релиза. Временное задание страницы хранится 30 минут.

## Локальная проверка для разработчика

Локальный запуск нужен только при доработке проекта, а не пользователям веб-приложения.

1. Скопируйте `.env.example` в `.env` и заполните параметры.
2. Выполните `npm install`, затем `npm run dev`.
3. Откройте адрес, который покажет Wrangler.

## Автоматизация Jira для изменений

### Изменение названия из карточки задачи

Карточка диаграммы отправляет в Worker ключ задачи и новое название. Worker принимает запрос после входа пользователя и вызывает отдельное правило Jira Automation. Секретный URL правила хранится в настройках Worker, а не в HTML. Интерфейс показывает новое название только после обратного подтверждения Jira. После подтверждения Worker сохраняет поправку в KV, чтобы она отображалась поверх старой CSV-выгрузки до следующего экспорта.

Создайте правило Jira Automation с областью действия для проектов `DEVELOP` и `PROJECTS`:

1. Триггер **Входящий веб-хук** → **Задачи, указанные в тексте запроса HTTP (метод POST) веб-хука**. Скопируйте выданный Jira URL.
2. Действие **Редактировать задачу**. В «Дополнительные поля» вставьте:

   ```json
   {"fields":{"summary":{{webhookData.change.summary.asJsonString}}}}
   ```

   Не выбирайте другие поля для изменения: правило должно менять только название. Ключ `change` выбран намеренно: у некоторых версий Jira Automation вложенный ключ `data` некорректно доступен через `webhookData`.
3. Действие **Повторно получить данные задачи** (*Re-fetch issue data*), чтобы следующее действие увидело новое название.
4. Действие **Отправить веб-запрос**: метод `POST`, URL `https://ekocrop-jira-release-map.skorokirzhaboy.workers.dev/api/issue-summary-callback`, заголовок `Content-Type: application/json`, тело «Пользовательские данные»:

   ```json
   {
     "requestId": "{{webhookData.change.requestId}}",
     "callbackToken": "{{webhookData.change.callbackToken}}",
     "issueKey": "{{issue.key}}",
     "summary": {{issue.summary.asJsonString}}
   }
   ```

5. Включите правило. В Cloudflare Worker задайте секрет `JIRA_SUMMARY_WEBHOOK_URL` (URL из шага 1). Право на редактирование названия определяется входом в сайт. Не добавляйте секреты в Git.

Worker посылает Jira тело вида `{"issues":["DEVELOP-5761"],"change":{"summary":"Новое название","requestId":"…","callbackToken":"…","callbackUrl":"…"}}`. HTTP-ответ от входящего webhook означает лишь принятие запроса. Успех в карточке показывается после callback из шага 4. Если callback не пришёл за 45 секунд, проверьте журнал выполнения правила Jira.

Документация Atlassian: [входящие webhook и `webhookData`](https://support.atlassian.com/jira/kb/use-incoming-webhooks-with-smart-values-in-automation-for-jira/), [редактирование полей JSON](https://confluence.atlassian.com/automation/advanced-field-editing-using-json-993924663.html), [JSON-функции smart values](https://confluence.atlassian.com/automation/json-functions-993924865.html).

### Синхронизация изменений между выгрузками

Новая целевая схема: полный снимок лежит в CSV, а Jira Automation отправляет в Worker только изменения между недельными выгрузками.

Триггеры для правила:

- задача создана;
- задача изменилась;
- изменился `fixVersion`;
- изменился статус;
- изменился тип задачи, приоритет, исполнитель, компоненты или связь с проектом.

Пока Worker принимает и полный снимок, старое правило ниже можно оставить как резервный вариант. Для новой схемы изменения лучше отправлять отдельным небольшим webhook, чтобы не расходовать KV на повторную отправку всех задач.

## Старый вариант полной синхронизации через Jira Automation

Используется одно правило. Оно запускается по расписанию, находит задачи всех поддерживаемых релизов и отправляет один полный снимок в Cloudflare.

### 1. Триггер «Запланированные»

1. Выберите удобную периодичность, для первого теста — один раз в день.
2. Выберите **«запустить поиск JQL и передать результаты последующим условиям и действиям»**.
3. Обязательно снимите флажок **«Учитывать только задачи, которые изменились с момента последнего выполнения правила»**. Иначе полный снимок будет неполным.
4. JQL:

```text
(project = DEVELOPMENT AND fixVersion is not EMPTY) OR project = PROJECTS
```

В дополнительных параметрах включите массовую обработку всех найденных задач, если Jira показывает этот переключатель.

Worker сам оставляет только версии, названия которых начинаются с `EkoCrop`, поэтому новые версии (например, `EkoCrop 8.1`, `EkoCrop 8.2` или `EkoCrop 14.1`) появятся на странице автоматически после очередной синхронизации.

### 2. Действие «Отправить веб-запрос»

- URL: `https://ekocrop-jira-release-map.skorokirzhaboy.workers.dev/api/jira-callback`
- Метод: `POST`
- Заголовок `Content-Type`: `application/json`
- «Дождитесь отклика»: для первого теста включено, затем можно выключить.
- Тело веб-хука: **«Пользовательские данные»**:

  ```json
  {
    "issues": [
      {{#issues}}
      {
        "key": {{key.asJsonString}},
        "summary": {{summary.asJsonString}},
        "issueType": {{issueType.name.asJsonString}},
        "status": {{status.name.asJsonString}},
        "priority": {{priority.name.asJsonString}},
        "assignee": {{assignee.displayName.asJsonString}},
        "components": {{components.name.asJsonStringArray}},
        "fixVersions": {{fixVersions.name.asJsonStringArray}},
        "parentKey": {{parent.key.asJsonString}},
        "issueLinks": [
          {{#issuelinks}}
          {
            "key": {{#inwardIssue}}{{key.asJsonString}}{{/}}{{#outwardIssue}}{{key.asJsonString}}{{/}},
            "type": {{type.name.asJsonString}}
          }{{^last}},{{/}}
          {{/}}
        ]
      }{{^last}},{{/}}
      {{/}}
    ]
  }
  ```

После сохранения вручную запустите правило один раз и откройте его журнал. Успешный ответ Worker содержит `"ok": true`, количество принятых задач и список сохранённых релизов.

## API

- `GET /api/health` — состояние опубликованного сервиса.
- `POST /api/auth/login` — проверка почты и пароля, выдача ключа сеанса.
- `GET /api/auth/me`, `POST /api/auth/logout` — проверка и завершение сеанса.
- `GET /api/releases` — список доступных релизов.
- `POST /api/jira-callback` — согласованный публичный адрес: принимает полный периодический снимок Jira без дополнительного токена; также совместим со старым callback разовых запросов с `requestId` и `callbackToken`.
- `POST /api/jira-snapshot` — дополнительный совместимый адрес для приёма полного снимка (в Jira использовать его не требуется).
- `POST /api/diagram-jobs` с `{"release":"10.0"}` — построение из последнего сохранённого снимка.
- `POST /api/jira-poll` — защищённая выдача ближайшего ожидающего запроса правилу-диспетчеру Jira.
- `GET /api/diagram-jobs/{id}` — состояние и готовая диаграмма.
- `POST /api/jira-callback/{id}?token=...` — прежний совместимый формат callback.

Служебные URL Jira хранятся только на сервере и не попадают в браузер.

## GitHub Pages и Render

GitHub Pages остаётся основным адресом приложения: `https://nykval.github.io/ekocrop-jira-release-map/`. Cloudflare Worker выполняет серверные запросы в фоне. Render после перехода на эту схему можно удалить.

## Проверка

```bash
npm test
```

Документация Atlassian:

- [Список `issues` при массовом JQL-триггере](https://confluence.atlassian.com/automation0801/jira-smart-values-issues-1223822701.html)
- [Данные входящего веб-хука через `webhookData`](https://support.atlassian.com/jira/kb/use-incoming-webhooks-with-smart-values-in-automation-for-jira/)
- [JSON-функции `asJsonString` и `asJsonStringArray`](https://support.atlassian.com/cloud-automation/docs/jira-smart-values-json-functions/)
