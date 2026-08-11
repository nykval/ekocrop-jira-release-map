import {createServer} from "node:http";
import {randomBytes, randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {fileURLToPath, pathToFileURL} from "node:url";
import {dirname, extname, join, normalize} from "node:path";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(moduleDirectory, "public");
const jobs = new Map();
const jobLifetimeMs = 30 * 60 * 1000;

const issueTypeRanks = {
  Epic: 5,
  Проект: 4,
  Project: 4,
  История: 3,
  Story: 3,
};

function text(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "object") {
    return text(value.displayName ?? value.name ?? value.value ?? value.key, fallback);
  }
  return String(value);
}

function uniqueStrings(values) {
  return [...new Set(values.flatMap(value => {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value.map(item => text(item)).filter(Boolean);
    return [text(value)].filter(Boolean);
  }))];
}

function linkedKeys(fields, raw) {
  const direct = uniqueStrings([raw.links, raw.linkedKeys, raw.parentKey, raw.parent]);
  const jiraLinks = Array.isArray(fields.issuelinks)
    ? fields.issuelinks.flatMap(link => [link.inwardIssue?.key, link.outwardIssue?.key])
    : [];
  return uniqueStrings([...direct, ...jiraLinks]);
}

export function normalizeIssue(raw, jiraBaseUrl = "https://dev.ekoniva-apk.com") {
  const fields = raw?.fields || raw || {};
  const key = text(raw?.key ?? fields.key);
  if (!key) throw new Error("В ответе Jira найдена задача без key");
  const components = uniqueStrings([raw.components, fields.components]);
  const parentKey = text(raw.parentKey ?? fields.parent?.key ?? raw.parent?.key);
  const links = linkedKeys(fields, raw).filter(link => link !== key);
  if (parentKey && !links.includes(parentKey)) links.unshift(parentKey);

  return {
    id: key,
    summary: text(raw.summary ?? fields.summary, key),
    taskType: text(raw.issueType ?? raw.taskType ?? fields.issuetype, "Задача"),
    status: text(raw.status ?? fields.status, "Не заполнено"),
    priority: text(raw.priority ?? fields.priority, "Не указан"),
    assignee: text(raw.assignee ?? fields.assignee, "Не назначен"),
    url: text(raw.url, `${jiraBaseUrl.replace(/\/$/, "")}/browse/${encodeURIComponent(key)}`),
    components,
    links,
    parentKey,
    external: false,
    synthetic: false,
  };
}

function projectCandidate(issue) {
  return issue.id.startsWith("PROJECTS-") || ["Проект", "Project", "Epic"].includes(issue.taskType);
}

function candidateScore(issue, issuesByKey) {
  const nonProjectLinks = issue.links.filter(key => {
    const linked = issuesByKey.get(key);
    return linked && !projectCandidate(linked);
  }).length;
  return (issueTypeRanks[issue.taskType] || 0) * 100 + nonProjectLinks;
}

function chooseProject(issue, candidates, issuesByKey, parentByProject) {
  const linked = issue.links
    .map(key => candidates.get(key))
    .filter(Boolean)
    .sort((a, b) => candidateScore(b, issuesByKey) - candidateScore(a, issuesByKey));
  let selected = issue.parentKey ? candidates.get(issue.parentKey) : null;
  if (!selected) selected = linked[0] || null;
  const seen = new Set();
  while (selected && parentByProject.has(selected.id) && !seen.has(selected.id)) {
    seen.add(selected.id);
    selected = candidates.get(parentByProject.get(selected.id)) || selected;
  }
  return selected;
}

function syntheticGroup(id, summary, taskType, tasks) {
  return {
    group: {
      id,
      summary,
      taskType,
      status: "Служебная группа",
      priority: "—",
      assignee: "—",
      url: null,
      external: false,
      synthetic: true,
    },
    tasks,
    synthetic: true,
  };
}

export function buildDiagramData(release, rawIssues, jiraBaseUrl = "https://dev.ekoniva-apk.com") {
  if (!Array.isArray(rawIssues)) throw new Error("Jira должна вернуть массив issues");
  const issues = rawIssues.map(issue => normalizeIssue(issue, jiraBaseUrl));
  const issuesByKey = new Map(issues.map(issue => [issue.id, issue]));
  const candidates = new Map(issues.filter(projectCandidate).map(issue => [issue.id, issue]));
  const parentByProject = new Map();

  for (const issue of candidates.values()) {
    const possibleParents = issue.links
      .map(key => candidates.get(key))
      .filter(Boolean)
      .filter(candidate => candidate.id !== issue.id)
      .sort((a, b) => candidateScore(b, issuesByKey) - candidateScore(a, issuesByKey));
    const explicit = issue.parentKey ? candidates.get(issue.parentKey) : null;
    const parent = explicit || possibleParents.find(candidate => (
      candidateScore(candidate, issuesByKey) > candidateScore(issue, issuesByKey)
    ));
    if (parent) parentByProject.set(issue.id, parent.id);
  }

  const topLevelProjects = [...candidates.values()].filter(issue => !parentByProject.has(issue.id));
  const taskBuckets = new Map(topLevelProjects.map(project => [project.id, []]));
  const unassigned = [];

  for (const issue of issues) {
    if (taskBuckets.has(issue.id)) continue;
    const project = chooseProject(issue, candidates, issuesByKey, parentByProject);
    if (project && taskBuckets.has(project.id)) taskBuckets.get(project.id).push(issue);
    else unassigned.push(issue);
  }

  const groups = topLevelProjects.map(project => ({
    group: project,
    tasks: taskBuckets.get(project.id) || [],
    synthetic: false,
  }));
  const bugs = unassigned.filter(issue => ["Ошибка", "Bug"].includes(issue.taskType));
  const refactoring = unassigned.filter(issue => ["Рефакторинг", "Refactoring"].includes(issue.taskType));
  const other = unassigned.filter(issue => !bugs.includes(issue) && !refactoring.includes(issue));
  if (bugs.length) groups.push(syntheticGroup("group-bugs", "Ошибки без проекта", "Ошибка", bugs));
  if (refactoring.length) groups.push(syntheticGroup("group-refactoring", "Рефакторинг без проекта", "Рефакторинг", refactoring));
  if (other.length) groups.push(syntheticGroup("group-other", "Без проекта", "Группа", other));

  const componentsByIssue = Object.fromEntries(
    issues.filter(issue => issue.components.length).map(issue => [issue.id, issue.components]),
  );
  const unassignedTypes = {};
  for (const issue of unassigned) {
    unassignedTypes[issue.taskType] = (unassignedTypes[issue.taskType] || 0) + 1;
  }
  const realGroups = groups.filter(group => !group.synthetic);
  const serviceGroups = groups.filter(group => group.synthetic);
  const summary = {
    releaseIssues: issues.length,
    projectGroups: realGroups.length,
    serviceGroups: serviceGroups.length,
    level2Tasks: groups.reduce((count, group) => count + group.tasks.length, 0),
    level1ReleaseIssues: realGroups.length,
    unassigned: unassigned.length,
    unassignedTypes,
    ambiguousPairsIgnored: [],
    largestGroups: [...groups]
      .sort((a, b) => b.tasks.length - a.tasks.length)
      .slice(0, 10)
      .map(group => ({id: group.group.id, count: group.tasks.length, summary: group.group.summary})),
  };

  return {
    data: {
      release: {
        id: `release-${release}`,
        summary: `Релиз EkoCrop ${release}`,
        taskType: "Релиз",
        status: "Загружен",
        url: null,
        external: false,
        synthetic: true,
      },
      groups,
      summary,
    },
    componentsByIssue,
  };
}

function configuredReleases() {
  return (process.env.RELEASES || "10.0")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
    .map(name => ({id: name, name}));
}

async function jiraReleases() {
  const baseUrl = process.env.JIRA_BASE_URL;
  const auth = process.env.JIRA_AUTH_HEADER;
  const projects = (process.env.JIRA_PROJECT_KEYS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  if (!baseUrl || !auth || !projects.length) return configuredReleases();

  const versions = [];
  for (const project of projects) {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/api/2/project/${encodeURIComponent(project)}/versions`, {
      headers: {Authorization: auth, Accept: "application/json"},
    });
    if (!response.ok) throw new Error(`Jira versions: HTTP ${response.status}`);
    const projectVersions = await response.json();
    versions.push(...projectVersions);
  }
  const unique = new Map();
  for (const version of versions) {
    if (!version?.name || version.archived) continue;
    unique.set(version.name, {
      id: String(version.id || version.name),
      name: version.name,
      released: Boolean(version.released),
      releaseDate: version.releaseDate || null,
    });
  }
  return [...unique.values()].sort((a, b) => b.name.localeCompare(a.name, "ru", {numeric: true}));
}

async function readJson(request, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Тело запроса слишком большое");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function publicBaseUrl(request) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, "");
  const protocol = request.headers["x-forwarded-proto"] || "http";
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  return `${protocol}://${host}`;
}

function integrationMode() {
  return process.env.JIRA_AUTOMATION_WEBHOOK_URL ? "automation" : "not-configured";
}

async function startJob(request, response) {
  const payload = await readJson(request, 64 * 1024);
  const release = text(payload.release);
  if (!release || release.length > 100) return sendJson(response, 400, {error: "Выберите корректный релиз"});
  const webhookUrl = process.env.JIRA_AUTOMATION_WEBHOOK_URL;
  if (!webhookUrl) {
    return sendJson(response, 503, {
      error: "Интеграция не настроена: задайте JIRA_AUTOMATION_WEBHOOK_URL",
    });
  }

  const id = randomUUID();
  const callbackToken = randomBytes(24).toString("hex");
  const callbackUrl = `${publicBaseUrl(request)}/api/jira-callback/${id}?token=${callbackToken}`;
  const job = {id, release, callbackToken, status: "pending", createdAt: Date.now()};
  jobs.set(id, job);

  const headers = {"Content-Type": "application/json", Accept: "application/json"};
  if (process.env.JIRA_AUTOMATION_WEBHOOK_TOKEN) {
    headers["X-Automation-Webhook-Token"] = process.env.JIRA_AUTOMATION_WEBHOOK_TOKEN;
  }
  try {
    const jiraResponse = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({requestId: id, release, callbackUrl}),
    });
    if (!jiraResponse.ok) throw new Error(`Jira Automation: HTTP ${jiraResponse.status}`);
    return sendJson(response, 202, {id, release, status: job.status});
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    return sendJson(response, 502, {error: job.error, id});
  }
}

async function acceptCallback(request, response, id, url) {
  const job = jobs.get(id);
  if (!job) return sendJson(response, 404, {error: "Запрос не найден или устарел"});
  if (url.searchParams.get("token") !== job.callbackToken) {
    return sendJson(response, 403, {error: "Неверный callback token"});
  }
  if (job.status === "ready") {
    return sendJson(response, 409, {error: "Результат для этого запроса уже получен"});
  }
  try {
    const payload = await readJson(request);
    const issues = Array.isArray(payload) ? payload : payload.issues;
    job.result = buildDiagramData(
      job.release,
      issues,
      process.env.JIRA_BASE_URL || "https://dev.ekoniva-apk.com",
    );
    job.status = "ready";
    job.completedAt = Date.now();
    return sendJson(response, 200, {ok: true, issueCount: job.result.data.summary.releaseIssues});
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    return sendJson(response, 400, {error: job.error});
  }
}

function jobStatus(response, id) {
  const job = jobs.get(id);
  if (!job) return sendJson(response, 404, {error: "Запрос не найден или устарел"});
  return sendJson(response, 200, {
    id: job.id,
    release: job.release,
    status: job.status,
    error: job.error,
    result: job.status === "ready" ? job.result : undefined,
  });
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(publicDirectory, safePath);
  if (!filePath.startsWith(publicDirectory)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    const types = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"};
    response.writeHead(200, {
      "Content-Type": types[extname(filePath)] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
      "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}

export function createAppServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    try {
      if (request.method === "GET" && url.pathname === "/api/releases") {
        const releases = await jiraReleases();
        return sendJson(response, 200, {releases, mode: integrationMode()});
      }
      if (request.method === "POST" && url.pathname === "/api/diagram-jobs") {
        return await startJob(request, response);
      }
      const jobMatch = url.pathname.match(/^\/api\/diagram-jobs\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && jobMatch) return jobStatus(response, jobMatch[1]);
      const callbackMatch = url.pathname.match(/^\/api\/jira-callback\/([0-9a-f-]+)$/i);
      if (request.method === "POST" && callbackMatch) {
        return await acceptCallback(request, response, callbackMatch[1], url);
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return await serveStatic(response, url.pathname);
      }
      return sendJson(response, 405, {error: "Method not allowed"});
    } catch (error) {
      return sendJson(response, 500, {error: error.message || "Внутренняя ошибка"});
    }
  });
}

setInterval(() => {
  const threshold = Date.now() - jobLifetimeMs;
  for (const [id, job] of jobs) {
    if (job.createdAt < threshold) jobs.delete(id);
  }
}, 60_000).unref();

const executedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (executedDirectly) {
  const port = Number(process.env.PORT || 8787);
  createAppServer().listen(port, () => {
    console.log(`Jira release map: http://localhost:${port}`);
  });
}
