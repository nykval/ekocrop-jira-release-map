# Карта релизов EkoCrop — Cloudflare Workers

Полноценное веб-приложение: пользователь открывает публичный адрес, выбирает релиз от 6.0 до 14.0, Jira Automation находит задачи по JQL и возвращает их приложению для построения интерактивной диаграммы.

Главная страница репозитория содержит `index.html`, поэтому при публикации сайта открывается непосредственно диаграмма. Этот README отображается только при просмотре исходного кода на GitHub.

## Публикация веб-приложения

GitHub хранит исходный код, а Cloudflare Worker одновременно публикует страницу, выполняет серверные запросы и принимает callback Jira. Ожидающие задания временно хранятся в Workers KV.

### Cloudflare

1. В Cloudflare откройте **Workers & Pages → Create → Import a repository** и выберите этот репозиторий.
2. Build command: `npm run deploy`. Для первого подключения можно использовать стандартные настройки Cloudflare Workers.
3. Создайте Workers KV namespace, например `ekocrop-jira-jobs`, и добавьте к Worker binding с именем `JOBS`.
4. В **Settings → Variables and Secrets** добавьте Secret `JIRA_AUTOMATION_WEBHOOK_URL`.
5. Если у входящего веб-хука Jira настроен секретный ключ, добавьте Secret `JIRA_AUTOMATION_WEBHOOK_TOKEN`.
6. Нажмите Deploy. Пользовательский адрес будет иметь вид `https://ekocrop-jira-release-map.<поддомен>.workers.dev`.

В `wrangler.jsonc` уже настроены Worker, статические файлы и API. После подключения GitHub обновления ветки `main` публикуются автоматически.

### Обязательные параметры сервера

| Переменная | Назначение |
|---|---|
| `JIRA_AUTOMATION_WEBHOOK_URL` | URL триггера «Входящий веб-хук» |
| `RELEASES` | Доступные релизы: от `6.0` до `14.0` |
| `JIRA_BASE_URL` | Адрес Jira для ссылок и REST API |

KV хранит каждое задание 30 минут, после чего Cloudflare удаляет его автоматически.

## Локальная проверка для разработчика

Локальный запуск нужен только при доработке проекта, а не пользователям веб-приложения.

1. Скопируйте `.env.example` в `.env` и заполните параметры.
2. Выполните `npm install`, затем `npm run dev`.
3. Откройте адрес, который покажет Wrangler.

## Основная интеграция через Jira Automation

### 1. Триггер «Входящий веб-хук»

- Выберите «Задачи, указанные с помощью следующего поискового запроса JQL».
- JQL:

```text
fixVersion = "{{webhookData.releaseVersion}}"
```

- В дополнительных параметрах включите массовую обработку всех найденных задач. Это делает список `{{issues}}` доступным одному запуску правила.
- Скопируйте URL веб-хука в `JIRA_AUTOMATION_WEBHOOK_URL`.
- Если для триггера задан секрет, сохраните его в `JIRA_AUTOMATION_WEBHOOK_TOKEN`.

### 2. Действие «Отправить веб-запрос»

- URL: постоянный публичный адрес Worker с путём `/api/jira-callback`, например `https://ekocrop-jira-release-map.<поддомен>.workers.dev/api/jira-callback`.
- Метод: `POST`
- Заголовок: `Content-Type: application/json`
- «Дождитесь отклика»: выключено.
- Тело веб-хука: «Пользовательские данные» со следующим JSON:

  ```json
  {
    "requestId": {{webhookData.requestId.asJsonString}},
    "callbackToken": {{webhookData.callbackToken.asJsonString}},
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
        "parentKey": {{parent.key.asJsonString}},
        "linkedKeys": [
          {{#issuelinks}}
          {{#inwardIssue}}{{key.asJsonString}}{{/}}{{#outwardIssue}}{{key.asJsonString}}{{/}}{{^last}},{{/}}
          {{/}}
        ]
      }{{^last}},{{/}}
      {{/}}
    ]
  }
  ```

После сохранения включите правило и проверьте его журнал. Веб-хук отвечает сразу, а результат приходит в сервис отдельным callback-запросом.

## API

- `GET /api/health` — состояние опубликованного сервиса.
- `GET /api/releases` — список доступных релизов.
- `POST /api/diagram-jobs` с `{"release":"10.0"}` — запуск построения.
- `GET /api/diagram-jobs/{id}` — состояние и готовая диаграмма.
- `POST /api/jira-callback` — callback Jira Automation; идентификатор и одноразовый токен передаются в JSON.
- `POST /api/jira-callback/{id}?token=...` — прежний совместимый формат callback.

URL Jira и токены хранятся только на сервере и не попадают в браузер.

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
