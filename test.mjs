import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {buildDiagramData, createAppServer} from "./server.mjs";

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

test("веб-хук, callback и опрос задания работают вместе", async () => {
  let callbackPromise;
  const jiraMock = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end("{}");
    callbackPromise = fetch(body.callbackUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({issues: sampleIssues}),
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
