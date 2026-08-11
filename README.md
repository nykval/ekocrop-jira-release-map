# Карта релизов EkoCrop

Страница позволяет выбрать релиз, запускает Jira Automation через входящий веб-хук, ожидает обратный вызов со списком задач и перестраивает диаграмму без перезагрузки.

## Запуск

Требуется Node.js 20 или новее. Внешние библиотеки не нужны.

1. Скопируйте `.env.example` в `.env` и заполните параметры.
2. Запустите сервис:

   ```bash
   node --env-file=.env server.mjs
   ```

3. Откройте `http://localhost:8787`.

`APP_BASE_URL` должен быть доступен из Jira. Для локальной разработки потребуется корпоративный reverse proxy или туннель до локального порта.

## Настройка Jira Automation

### 1. Триггер «Входящий веб-хук»

- Выберите «Задачи, указанные с помощью следующего поискового запроса JQL».
- JQL:

  ```text
  fixVersion = "{{webhookData.release}}"
  ```

- В дополнительных параметрах включите массовую обработку всех найденных задач. Это делает список `{{issues}}` доступным одному запуску правила.
- Скопируйте URL веб-хука в `JIRA_AUTOMATION_WEBHOOK_URL`.
- Если для триггера задан секрет, сохраните его в `JIRA_AUTOMATION_WEBHOOK_TOKEN`.

### 2. Действие «Отправить веб-запрос»

- URL: `{{webhookData.callbackUrl}}`
- Метод: `POST`
- Заголовок: `Content-Type: application/json`
- Тело запроса: «Пользовательские данные» со следующим JSON:

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

- `GET /api/releases` — список доступных релизов.
- `POST /api/diagram-jobs` с `{"release":"10.0"}` — запуск построения.
- `GET /api/diagram-jobs/{id}` — состояние и готовая диаграмма.
- `POST /api/jira-callback/{id}?token=...` — защищённый одноразовым токеном callback Jira Automation.

URL Jira и токены хранятся только на сервере и не попадают в браузер.

## Проверка

```bash
npm test
```

Документация Atlassian:

- [Список `issues` при массовом JQL-триггере](https://confluence.atlassian.com/automation0801/jira-smart-values-issues-1223822701.html)
- [Данные входящего веб-хука через `webhookData`](https://support.atlassian.com/jira/kb/use-incoming-webhooks-with-smart-values-in-automation-for-jira/)
- [JSON-функции `asJsonString` и `asJsonStringArray`](https://support.atlassian.com/cloud-automation/docs/jira-smart-values-json-functions/)
