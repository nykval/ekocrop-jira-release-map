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
  async delete(key) { this.values.delete(key); }
  async list({prefix = "", limit = 1000} = {}) {
    return {keys: [...this.values.keys()].filter(key => key.startsWith(prefix)).slice(0, limit).map(name => ({name}))};
  }
}

test("Jira сохраняет периодический снимок через согласованный callback, а страница читает его из KV", async () => {
  const JOBS = new MemoryKV();
  const env = {
    JOBS,
    JIRA_BASE_URL: "https://jira.example.test",
    ASSETS: {fetch: () => new Response("asset")},
  };
  const snapshotIssues = [
    {...sampleIssues[0], fixVersions: []},
    {...sampleIssues[1], fixVersions: ["EkoCrop 8.2", "EkoCrop 10.0"]},
    {...sampleIssues[2], fixVersions: ["EkoCrop 9.0", "EkoCrop 10.0"]},
  ];
  const savedResponse = await worker.fetch(new Request("https://map.example/api/jira-callback", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({issues: snapshotIssues}),
  }), env);
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.receivedIssues, 3);
  assert.deepEqual(saved.releases.map(item => item.release), ["8.2", "9.0", "10.0"]);

  const releasesResponse = await worker.fetch(new Request("https://map.example/api/releases"), env);
  const releases = await releasesResponse.json();
  assert.equal(releases.mode, "jira-snapshot");
  assert.equal(releases.releases.find(item => item.name === "8.2").available, true);
  assert.equal(releases.releases.find(item => item.name === "10.0").available, true);

  const createdResponse = await worker.fetch(new Request("https://map.example/api/diagram-jobs", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({release: "10.0"}),
  }), env);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.status, "ready");
  const statusResponse = await worker.fetch(new Request(`https://map.example/api/diagram-jobs/${created.id}`), env);
  const status = await statusResponse.json();
  assert.equal(status.result.data.summary.projectGroups, 1);
  assert.equal(status.result.data.summary.releaseIssues, 3);
});

test("Cloudflare-версия строит те же группы диаграммы", () => {
  const result = buildDiagramData("10.0", sampleIssues);
  assert.equal(result.data.summary.releaseIssues, 3);
  assert.equal(result.data.summary.projectGroups, 1);
  assert.equal(result.data.groups.find(group => group.group.id === "PROJECTS-1").tasks.length, 1);
});

test("Cloudflare Worker связывает очередь, Jira dispatcher, callback и опрос через KV", async () => {
  const JOBS = new MemoryKV();
  const env = {
    JOBS,
    JIRA_POLL_TOKEN: "dispatcher-secret",
    JIRA_BASE_URL: "https://jira.example.test",
    ASSETS: {fetch: () => new Response("asset")},
  };
  const createdResponse = await worker.fetch(new Request("https://map.example/api/diagram-jobs", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({release: "10.0"}),
  }), env);
  assert.equal(createdResponse.status, 202);
  const created = await createdResponse.json();
  assert.equal(created.status, "queued");

  const unauthorized = await worker.fetch(new Request("https://map.example/api/jira-poll", {method: "POST"}), env);
  assert.equal(unauthorized.status, 401);
  const pollResponse = await worker.fetch(new Request("https://map.example/api/jira-poll", {
    method: "POST",
    headers: {"X-Jira-Poll-Token": "dispatcher-secret"},
  }), env);
  assert.equal(pollResponse.status, 200);
  const dispatch = await pollResponse.json();
  assert.equal(dispatch.pending, true);
  assert.equal(dispatch.releaseVersion, "10.0");
  assert.equal(dispatch.callbackUrl, "https://map.example/api/jira-callback");

  const callbackResponse = await worker.fetch(new Request(dispatch.callbackUrl, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({requestId: dispatch.requestId, callbackToken: dispatch.callbackToken, issues: sampleIssues}),
  }), env);
  assert.equal(callbackResponse.status, 200);

  const statusResponse = await worker.fetch(new Request(`https://map.example/api/diagram-jobs/${created.id}`), env);
  const status = await statusResponse.json();
  assert.equal(status.status, "ready");
  assert.equal(status.result.data.summary.releaseIssues, 3);

  const emptyPoll = await worker.fetch(new Request("https://map.example/api/jira-poll", {
    method: "POST",
    headers: {"X-Jira-Poll-Token": "dispatcher-secret"},
  }), env);
  assert.deepEqual(await emptyPoll.json(), {pending: false});
});

test("Cloudflare Worker отдаёт релизы 6.0–14.0", async () => {
  const response = await worker.fetch(new Request("https://map.example/api/releases"), {});
  const payload = await response.json();
  assert.deepEqual(payload.releases.map(item => item.name), ["6.0", "7.0", "8.0", "9.0", "10.0", "11.0", "12.0", "13.0", "14.0"]);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://nykval.github.io");
});

test("Cloudflare Worker разрешает браузерные запросы с GitHub Pages", async () => {
  const response = await worker.fetch(new Request("https://map.example/api/diagram-jobs", {
    method: "OPTIONS",
    headers: {
      Origin: "https://nykval.github.io",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  }), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://nykval.github.io");
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /POST/);
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Content-Type/i);
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
  assert.equal(result.data.groups[0].tasks[0].relationLabel, "subtask");
});
