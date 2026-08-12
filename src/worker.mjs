const RELEASES = Array.from({length: 9}, (_, index) => `${index + 6}.0`);
const JOB_TTL_SECONDS = 30 * 60;

const issueTypeRanks = {Epic: 5, Проект: 4, Project: 4, История: 3, Story: 3};

function text(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "object") return text(value.displayName ?? value.name ?? value.value ?? value.key, fallback);
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

function normalizeIssue(raw, jiraBaseUrl) {
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
    group: {id, summary, taskType, status: "Служебная группа", priority: "—", assignee: "—", url: null, external: false, synthetic: true},
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
    const parent = explicit || possibleParents.find(candidate => candidateScore(candidate, issuesByKey) > candidateScore(issue, issuesByKey));
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

  const groups = topLevelProjects.map(project => ({group: project, tasks: taskBuckets.get(project.id) || [], synthetic: false}));
  const bugs = unassigned.filter(issue => ["Ошибка", "Bug"].includes(issue.taskType));
  const refactoring = unassigned.filter(issue => ["Рефакторинг", "Refactoring"].includes(issue.taskType));
  const other = unassigned.filter(issue => !bugs.includes(issue) && !refactoring.includes(issue));
  if (bugs.length) groups.push(syntheticGroup("group-bugs", "Ошибки без проекта", "Ошибка", bugs));
  if (refactoring.length) groups.push(syntheticGroup("group-refactoring", "Рефакторинг без проекта", "Рефакторинг", refactoring));
  if (other.length) groups.push(syntheticGroup("group-other", "Без проекта", "Группа", other));

  const componentsByIssue = Object.fromEntries(issues.filter(issue => issue.components.length).map(issue => [issue.id, issue.components]));
  const unassignedTypes = {};
  for (const issue of unassigned) unassignedTypes[issue.taskType] = (unassignedTypes[issue.taskType] || 0) + 1;
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
    largestGroups: [...groups].sort((a, b) => b.tasks.length - a.tasks.length).slice(0, 10).map(group => ({id: group.group.id, count: group.tasks.length, summary: group.group.summary})),
  };
  return {
    data: {
      release: {id: `release-${release}`, summary: `Релиз EkoCrop ${release}`, taskType: "Релиз", status: "Загружен", url: null, external: false, synthetic: true},
      groups,
      summary,
    },
    componentsByIssue,
  };
}

function json(value, status = 200) {
  return Response.json(value, {status, headers: {"Cache-Control": "no-store"}});
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function readPayload(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 10 * 1024 * 1024) throw new Error("Тело запроса слишком большое");
  return request.json();
}

function requireBindings(env) {
  if (!env.JOBS) throw new Error("Cloudflare KV binding JOBS не настроен");
}

async function startJob(request, env) {
  requireBindings(env);
  const payload = await readPayload(request);
  const release = text(payload.release);
  if (!RELEASES.includes(release)) return json({error: "Выберите релиз от 6.0 до 14.0"}, 400);
  if (!env.JIRA_AUTOMATION_WEBHOOK_URL) return json({error: "Секрет JIRA_AUTOMATION_WEBHOOK_URL не настроен"}, 503);

  const id = crypto.randomUUID();
  const callbackToken = randomToken();
  const callbackUrl = `${new URL(request.url).origin}/api/jira-callback`;
  const job = {id, release, callbackToken, status: "pending", createdAt: Date.now()};
  await env.JOBS.put(`job:${id}`, JSON.stringify(job), {expirationTtl: JOB_TTL_SECONDS});

  const headers = {"Content-Type": "application/json", Accept: "application/json"};
  if (env.JIRA_AUTOMATION_WEBHOOK_TOKEN) headers["X-Automation-Webhook-Token"] = env.JIRA_AUTOMATION_WEBHOOK_TOKEN;
  try {
    const jiraResponse = await fetch(env.JIRA_AUTOMATION_WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: id,
        release,
        callbackToken,
        callbackUrl,
        data: {releaseVersion: release, requestId: id, callbackToken, callbackUrl},
      }),
    });
    if (!jiraResponse.ok) throw new Error(`Jira Automation: HTTP ${jiraResponse.status}`);
    return json({id, release, status: "pending"}, 202);
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    await env.JOBS.put(`job:${id}`, JSON.stringify(job), {expirationTtl: JOB_TTL_SECONDS});
    return json({error: job.error, id}, 502);
  }
}

async function acceptCallback(request, env) {
  requireBindings(env);
  const payload = await readPayload(request);
  const id = text(payload.requestId);
  const token = text(payload.callbackToken);
  const stored = id && await env.JOBS.get(`job:${id}`);
  if (!stored) return json({error: "Запрос не найден или устарел"}, 404);
  const job = JSON.parse(stored);
  if (token !== job.callbackToken) return json({error: "Неверный callback token"}, 403);
  if (job.status === "ready") return json({error: "Результат для этого запроса уже получен"}, 409);
  try {
    const issues = Array.isArray(payload) ? payload : payload.issues;
    job.result = buildDiagramData(job.release, issues, env.JIRA_BASE_URL || "https://dev.ekoniva-apk.com");
    job.status = "ready";
    job.completedAt = Date.now();
    delete job.callbackToken;
    await env.JOBS.put(`job:${id}`, JSON.stringify(job), {expirationTtl: JOB_TTL_SECONDS});
    return json({ok: true, issueCount: job.result.data.summary.releaseIssues});
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    await env.JOBS.put(`job:${id}`, JSON.stringify(job), {expirationTtl: JOB_TTL_SECONDS});
    return json({error: job.error}, 400);
  }
}

async function jobStatus(id, env) {
  requireBindings(env);
  const stored = await env.JOBS.get(`job:${id}`);
  if (!stored) return json({error: "Запрос не найден или устарел"}, 404);
  const job = JSON.parse(stored);
  return json({id: job.id, release: job.release, status: job.status, error: job.error, result: job.status === "ready" ? job.result : undefined});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/releases") {
        return json({releases: RELEASES.map(name => ({id: name, name})), mode: env.JIRA_AUTOMATION_WEBHOOK_URL ? "automation" : "not-configured"});
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ok: true, platform: "cloudflare-workers", integration: env.JIRA_AUTOMATION_WEBHOOK_URL ? "automation" : "not-configured", storage: env.JOBS ? "ready" : "not-configured"});
      }
      if (request.method === "POST" && url.pathname === "/api/diagram-jobs") return startJob(request, env);
      const jobMatch = url.pathname.match(/^\/api\/diagram-jobs\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && jobMatch) return jobStatus(jobMatch[1], env);
      if (request.method === "POST" && url.pathname === "/api/jira-callback") return acceptCallback(request, env);
      if (request.method === "GET" || request.method === "HEAD") return env.ASSETS.fetch(request);
      return json({error: "Method not allowed"}, 405);
    } catch (error) {
      return json({error: error.message || "Внутренняя ошибка"}, 500);
    }
  },
};
