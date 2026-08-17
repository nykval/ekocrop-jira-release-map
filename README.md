# Карта релизов EkoCrop — Cloudflare Workers

Полноценное веб-приложение: Jira Automation по расписанию отправляет полный снимок задач в Cloudflare Workers KV. Пользователь открывает публичный адрес, выбирает любой найденный релиз EkoCrop и сразу строит интерактивную диаграмму из сохранённых данных.

Главная страница репозитория содержит `index.html`, поэтому при публикации сайта открывается непосредственно диаграмма. Этот README отображается только при просмотре исходного кода на GitHub.

## Публикация веб-приложения

GitHub хранит исходный код, а Cloudflare Worker одновременно публикует страницу, выполняет серверные запросы и принимает callback Jira. Ожидающие задания временно хранятся в Workers KV.

### Cloudflare

1. В Cloudflare откройте **Workers & Pages → Create → Import a repository** и выберите этот репозиторий.
2. Build command: `npm run deploy`. Для первого подключения можно использовать стандартные настройки Cloudflare Workers.
3. Создайте Workers KV namespace, например `ekocrop-jira-jobs`, и добавьте к Worker binding с именем `JOBS`.
4. Нажмите Deploy. Пользовательский адрес будет иметь вид `https://ekocrop-jira-release-map.<поддомен>.workers.dev`.

В `wrangler.jsonc` уже настроены Worker, статические файлы и API. После подключения GitHub обновления ветки `main` публикуются автоматически.

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

## Периодическая синхронизация через Jira Automation

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
- `GET /api/releases` — список доступных релизов.
- `POST /api/jira-callback` — согласованный публичный адрес: принимает полный периодический снимок Jira без дополнительного токена; также совместим со старым callback разовых запросов с `requestId` и `callbackToken`.
- `POST /api/jira-snapshot` — дополнительный совместимый адрес для приёма полного снимка (в Jira использовать его не требуется).
- `POST /api/diagram-jobs` с `{"release":"10.0"}` — построение из последнего сохранённого снимка.
- `POST /api/jira-poll` — защищённая выдача ближайшего ожидающего запроса правилу-диспетчеру Jira.
- `GET /api/diagram-jobs/{id}` — состояние и готовая диаграмма.
- `POST /api/jira-callback/{id}?token=...` — прежний совместимый формат callback.

Служебные URL Jira хранятся только на сервере и не попадают в браузер.

## GitHub Pages и Render

GitHub Pages можно отключить в **Settings → Pages → Build and deployment → Source → None**. Render после успешного перехода также можно удалить. Рабочий адрес приложения выдаёт Cloudflare Workers.

## Проверка

```bash
npm test
```

Документация Atlassian:

- [Список `issues` при массовом JQL-триггере](https://confluence.atlassian.com/automation0801/jira-smart-values-issues-1223822701.html)
- [Данные входящего веб-хука через `webhookData`](https://support.atlassian.com/jira/kb/use-incoming-webhooks-with-smart-values-in-automation-for-jira/)
- [JSON-функции `asJsonString` и `asJsonStringArray`](https://support.atlassian.com/cloud-automation/docs/jira-smart-values-json-functions/)
