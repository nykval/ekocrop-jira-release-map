import test from "node:test";
import assert from "node:assert/strict";
import worker, {buildDiagramData, jiraCsvRelease, jiraCsvToIssues} from "./src/worker.mjs";

const sampleIssues = [
  {key: "PROJECTS-1", summary: "[EkoCrop] Проект", issueType: "Проект", priority: "High", linkedKeys: ["DEVELOP-1"]},
  {key: "DEVELOP-1", summary: "Задача", issueType: "Задача", priority: "Medium", linkedKeys: ["PROJECTS-1"]},
  {key: "DEVELOP-2", summary: "Ошибка", issueType: "Ошибка", priority: "Highest"},
];

class MemoryKV {
  constructor() { this.values = new Map(); }
  async put(key, value) { this.values.set(key, value); }
  async get(key) { return this.values.get(key) ?? null; }
}

test("Cloudflare-версия строит те же группы диаграммы", () => {
  const result = buildDiagramData("10.0", sampleIssues);
  assert.equal(result.data.summary.releaseIssues, 3);
  assert.equal(result.data.summary.projectGroups, 1);
  assert.equal(result.data.groups.find(group => group.group.id === "PROJECTS-1").tasks.length, 1);
});

test("Cloudflare Worker связывает запуск, Jira callback и опрос через KV", async () => {
  const JOBS = new MemoryKV();
  let webhookPayload;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    webhookPayload = JSON.parse(options.body);
    return new Response("{}", {status: 200});
  };
  const env = {
    JOBS,
    JIRA_AUTOMATION_WEBHOOK_URL: "https://jira.example.test/hook",
    JIRA_BASE_URL: "https://jira.example.test",
    ASSETS: {fetch: () => new Response("asset")},
  };
  try {
    const createdResponse = await worker.fetch(new Request("https://map.example/api/diagram-jobs", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({release: "10.0"}),
    }), env);
    assert.equal(createdResponse.status, 202);
    const created = await createdResponse.json();
    assert.equal(webhookPayload.data.releaseVersion, "10.0");
    assert.equal(webhookPayload.callbackUrl, "https://map.example/api/jira-callback");

    const callbackResponse = await worker.fetch(new Request(webhookPayload.callbackUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({requestId: webhookPayload.requestId, callbackToken: webhookPayload.callbackToken, issues: sampleIssues}),
    }), env);
    assert.equal(callbackResponse.status, 200);

    const statusResponse = await worker.fetch(new Request(`https://map.example/api/diagram-jobs/${created.id}`), env);
    const status = await statusResponse.json();
    assert.equal(status.status, "ready");
    assert.equal(status.result.data.summary.releaseIssues, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cloudflare Worker отдаёт релизы 6.0–14.0", async () => {
  const response = await worker.fetch(new Request("https://map.example/api/releases"), {});
  const payload = await response.json();
  assert.deepEqual(payload.releases.map(item => item.name), ["6.0", "7.0", "8.0", "9.0", "10.0", "11.0", "12.0", "13.0", "14.0"]);
});

test("Cloudflare Worker импортирует CSV-экспорт Jira", async () => {
  const csv = [
    "Тема,Ключ проблемы,Тип задачи,Статус,Приоритет,Исполнитель,Компоненты,Исправить в версиях,Входящая связь задачи (subtasks-custom-link)",
    '"[EkoCrop] Проект",PROJECTS-1,Проект,Новый,High,,,EkoCrop 9.0,DEVELOP-1',
    '"Задача, с запятой",DEVELOP-1,Задача,Сделать,Medium,Иванов,backend,EkoCrop 9.0,PROJECTS-1',
  ].join("\n");
  assert.equal(jiraCsvRelease(csv), "9.0");
  const issues = jiraCsvToIssues(csv);
  assert.equal(issues.length, 2);
  assert.equal(issues[1].summary, "Задача, с запятой");
  const response = await worker.fetch(new Request("https://map.example/api/import-csv?release=10.0", {
    method: "POST",
    headers: {"Content-Type": "text/csv;charset=utf-8"},
    body: csv,
  }), {JIRA_BASE_URL: "https://jira.example.test"});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.data.release.summary, "Релиз EkoCrop 9.0");
  assert.equal(result.data.summary.releaseIssues, 2);
  assert.equal(result.data.groups[0].tasks[0].id, "DEVELOP-1");
});
