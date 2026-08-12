import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {buildDiagramData, createAppServer, searchJiraIssues} from "./server.mjs";

const sampleIssues = [
  {
    key: "PROJECTS-1",
    summary: "[EkoCrop] Проект релиза",
    issueType: "Проект",
    status: "В работе",
    priority: "High",
    linkedKeys: ["DEVELOP-1"],
  },
  {
    key: "DEVELOP-1",
    summary: "Реализовать функцию",
    issueType: "Задача",
    status: "Сделать",
    priority: "Medium",
    components: ["arch-tier: backend-srv"],
    linkedKeys: ["PROJECTS-1"],
  },
  {key: "DEVELOP-2", summary: "Исправить ошибку", issueType: "Ошибка", priority: "Highest"},
  {key: "DEVELOP-3", summary: "Рефакторинг", issueType: "Рефакторинг", priority: "Low"},
  {key: "DEVELOP-4", summary: "Отдельная задача", issueType: "Задача", priority: "Medium"},
];

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("buildDiagramData создаёт проекты и три служебные группы", () => {
  const result = buildDiagramData("11.0", sampleIssues);
  assert.equal(result.data.summary.releaseIssues, 5);
  assert.equal(result.data.summary.projectGroups, 1);
  assert.equal(result.data.summary.serviceGroups, 3);
  assert.equal(result.data.groups.find(group => group.group.id === "PROJECTS-1").tasks.length, 1);
  assert.equal(result.data.groups.at(-1).group.id, "group-other");
  assert.deepEqual(result.componentsByIssue["DEVELOP-1"], ["arch-tier: backend-srv"]);
});

test("Jira REST поиск формирует JQL релиза и получает все страницы", async () => {
  const previousBaseUrl = process.env.JIRA_BASE_URL;
  const previousAuth = process.env.JIRA_AUTH_HEADER;
  process.env.JIRA_BASE_URL = "https://jira.example.test";
  process.env.JIRA_AUTH_HEADER = "Bearer secret-test-token";
  const requests = [];
  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({url, options, body});
    const issues = body.startAt === 0 ? sampleIssues.slice(0, 2) : sampleIssues.slice(2);
    return new Response(JSON.stringify({issues, total: sampleIssues.length}), {
      status: 200,
      headers: {"Content-Type": "application/json"},
    });
  };
  try {
    const issues = await searchJiraIssues("10.0", mockFetch);
    assert.equal(issues.length, sampleIssues.length);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "https://jira.example.test/rest/api/2/search");
    assert.equal(requests[0].body.jql, 'fixVersion = "10.0" ORDER BY priority ASC, key ASC');
    assert.equal(requests[0].options.headers.Authorization, "Bearer secret-test-token");
    assert.equal(requests[1].body.startAt, 2);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.JIRA_BASE_URL;
    else process.env.JIRA_BASE_URL = previousBaseUrl;
    if (previousAuth === undefined) delete process.env.JIRA_AUTH_HEADER;
    else process.env.JIRA_AUTH_HEADER = previousAuth;
  }
});

test("веб-хук, callback и опрос задания работают вместе", async () => {
  let callbackPromise;
  const previousBaseUrl = process.env.JIRA_BASE_URL;
  const previousAuth = process.env.JIRA_AUTH_HEADER;
  delete process.env.JIRA_BASE_URL;
  delete process.env.JIRA_AUTH_HEADER;
  const jiraMock = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.data.releaseVersion, "11.0");
    assert.equal(body.data.callbackUrl, body.callbackUrl);
    assert.ok(body.data.callbackToken);
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end("{}");
    callbackPromise = fetch(body.callbackUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        requestId: body.data.requestId,
        callbackToken: body.data.callbackToken,
        issues: sampleIssues,
      }),
    });
  });
  const jiraPort = await listen(jiraMock);
  process.env.JIRA_AUTOMATION_WEBHOOK_URL = `http://127.0.0.1:${jiraPort}/hook`;

  const app = createAppServer();
  const appPort = await listen(app);
  process.env.APP_BASE_URL = `http://127.0.0.1:${appPort}`;

  try {
    const created = await fetch(`http://127.0.0.1:${appPort}/api/diagram-jobs`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({release: "11.0"}),
    });
    assert.equal(created.status, 202);
    const job = await created.json();
    const callback = await callbackPromise;
    assert.equal(callback.status, 200);

    const statusResponse = await fetch(`http://127.0.0.1:${appPort}/api/diagram-jobs/${job.id}`);
    const status = await statusResponse.json();
    assert.equal(status.status, "ready");
    assert.equal(status.result.data.summary.releaseIssues, 5);
  } finally {
    delete process.env.JIRA_AUTOMATION_WEBHOOK_URL;
    delete process.env.APP_BASE_URL;
    if (previousBaseUrl !== undefined) process.env.JIRA_BASE_URL = previousBaseUrl;
    if (previousAuth !== undefined) process.env.JIRA_AUTH_HEADER = previousAuth;
    await close(app);
    await close(jiraMock);
  }
});

test("главная страница сразу отдаёт приложение, а не README", async () => {
  const app = createAppServer();
  const appPort = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${appPort}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /data-release-form/);
    assert.match(html, /Карта релиза EkoCrop/);
    assert.doesNotMatch(html, /<h1[^>]*>\s*Карта релизов EkoCrop/);
  } finally {
    await close(app);
  }
});
