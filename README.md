# Карта релизов EkoCrop

Полноценное веб-приложение: пользователь открывает публичный адрес, выбирает релиз, приложение запрашивает задачи через Jira Automation и строит интерактивную диаграмму без локального запуска.

## Публикация веб-приложения

GitHub хранит исходный код, а приложение запускается как Web Service. GitHub Pages для этого проекта не подходит: он не запускает Node.js и не может безопасно хранить секрет Jira.

### Render — рекомендуемый вариант

1. Откройте [Render Dashboard](https://dashboard.render.com/) и нажмите **New → Blueprint**.
2. Подключите этот GitHub-репозиторий. Render автоматически прочитает файл `render.yaml`.
3. При создании сервиса заполните секретные переменные:
   - `JIRA_AUTOMATION_WEBHOOK_URL` — URL входящего веб-хука Jira Automation;
   - `JIRA_AUTOMATION_WEBHOOK_TOKEN` — только если для веб-хука настроен секрет;
   - `JIRA_AUTH_HEADER` — только если список релизов нужно получать через Jira REST API.
4. После завершения публикации откройте выданный адрес `https://...onrender.com`.

Render автоматически задаёт порт и публичный адрес. После каждого обновления ветки `main` приложение публикуется заново.

### Обязательные параметры сервера

| Переменная | Назначение |
|---|---|
| `JIRA_AUTOMATION_WEBHOOK_URL` | Запускает правило Jira для выбранного релиза |
| `RELEASES` | Резервный список релизов, например `10.0,10.1` |
| `JIRA_BASE_URL` | Адрес Jira для ссылок и REST API |

`APP_BASE_URL` на Render указывать не требуется. На других платформах задайте в нём публичный HTTPS-адрес приложения, доступный из Jira.

## Локальная проверка для разработчика

Локальный запуск нужен только при доработке проекта, а не пользователям веб-приложения.

1. Скопируйте `.env.example` в `.env` и заполните параметры.
2. Выполните `node --env-file=.env server.mjs`.
3. Откройте `http://localhost:8787`.

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

- `GET /api/health` — состояние опубликованного сервиса.
- `GET /api/releases` — список доступных релизов.
- `POST /api/diagram-jobs` с `{"release":"10.0"}` — запуск построения.
- `GET /api/diagram-jobs/{id}` — состояние и готовая диаграмма.
- `POST /api/jira-callback/{id}?token=...` — защищённый одноразовым токеном callback Jira Automation.

URL Jira и токены хранятся только на сервере и не попадают в браузер.

## GitHub Pages

Если GitHub Pages уже включён и показывает `README.md`, отключите его в **Settings → Pages → Build and deployment → Source → None**. Рабочий адрес приложения выдаёт Render, а не GitHub Pages.

## Проверка

```bash
npm test
```

Документация Atlassian:

- [Список `issues` при массовом JQL-триггере](https://confluence.atlassian.com/automation0801/jira-smart-values-issues-1223822701.html)
- [Данные входящего веб-хука через `webhookData`](https://support.atlassian.com/jira/kb/use-incoming-webhooks-with-smart-values-in-automation-for-jira/)
- [JSON-функции `asJsonString` и `asJsonStringArray`](https://support.atlassian.com/cloud-automation/docs/jira-smart-values-json-functions/)
