const DEFAULT_RELEASES = Array.from({length: 9}, (_, index) => `${index + 6}.0`);
const JOB_TTL_SECONDS = 30 * 60;
const CLAIM_RETRY_MS = 3 * 60 * 1000;
const SNAPSHOT_PREFIX = "snapshot:release:";

const issueTypeRanks = {Epic: 5, Проект: 4, Project: 4, История: 3, Story: 3};

function parseCsv(textValue) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(textValue || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  row.push(cell);
  if (row.some(value => value !== "")) rows.push(row);
  return rows;
}

function displayRelationName(value) {
  const name = text(value);
  const normalized = name.toLowerCase();
  if (normalized === "subtasks-custom-link") return "subtask";
  if (normalized === "relates") return "relates";
  if (normalized === "ссылка на эпик" || normalized === "epics-custom-link") return "epic";
  return name;
}

export function jiraCsvToIssues(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error("CSV-файл не содержит задач");
  const headers = rows[0].map(value => value.trim());
  const first = name => headers.indexOf(name);
  const all = predicate => headers.map((name, index) => predicate(name) ? index : -1).filter(index => index >= 0);
  const keyIndex = first("Ключ проблемы");
  const summaryIndex = first("Тема");
  if (keyIndex < 0 || summaryIndex < 0) throw new Error("Это не экспорт Jira: не найдены колонки «Ключ проблемы» и «Тема»");
  const typeIndex = first("Тип задачи");
  const statusIndex = first("Статус");
  const priorityIndex = first("Приоритет");
  const assigneeIndex = first("Исполнитель");
  const componentIndices = all(name => name === "Компоненты");
  const relationIndices = all(name => /связ|ссылка на эпик|родительская ссылка/i.test(name));
  const parentIndices = all(name => /ссылка на эпик|родительская ссылка/i.test(name));
  const value = (rowValue, index) => index >= 0 ? text(rowValue[index]) : "";
  const issues = rows.slice(1).map(rowValue => {
    const key = value(rowValue, keyIndex);
    if (!key) return null;
    const relationTypes = {};
    for (const index of relationIndices) {
      const linkedKey = value(rowValue, index);
      const relationName = displayRelationName(headers[index].match(/\(([^()]*)\)\s*$/)?.[1]?.trim());
      if (!linkedKey || !relationName) continue;
      relationTypes[linkedKey] = uniqueStrings([relationTypes[linkedKey], relationName]);
    }
    return {
      key,
      summary: value(rowValue, summaryIndex),
      issueType: value(rowValue, typeIndex),
      status: value(rowValue, statusIndex),
      priority: value(rowValue, priorityIndex),
      assignee: value(rowValue, assigneeIndex),
      components: uniqueStrings(componentIndices.map(index => rowValue[index])),
      linkedKeys: uniqueStrings(relationIndices.map(index => rowValue[index])),
      relationTypes,
      parentKey: parentIndices.map(index => value(rowValue, index)).find(Boolean) || "",
    };
  }).filter(Boolean);
  const issuesByKey = new Map(issues.map(issue => [issue.key, issue]));
  for (const issue of issues) {
    for (const linkedKey of issue.linkedKeys) {
      const linked = issuesByKey.get(linkedKey);
      if (linked && !linked.linkedKeys.includes(issue.key)) linked.linkedKeys.push(issue.key);
      if (linked && issue.relationTypes[linkedKey]?.length) {
        linked.relationTypes[issue.key] = uniqueStrings([
          linked.relationTypes[issue.key],
          issue.relationTypes[linkedKey],
        ]);
      }
    }
  }
  return issues;
}

export function jiraCsvRelease(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error("CSV-файл не содержит задач");
  const headers = rows[0].map(value => value.trim());
  const versionIndices = headers
    .map((name, index) => name === "Исправить в версиях" ? index : -1)
    .filter(index => index >= 0);
  if (!versionIndices.length) {
    throw new Error("В CSV нет колонки «Исправить в версиях»");
  }
  const counts = new Map();
  for (const row of rows.slice(1)) {
    const rowReleases = new Set(versionIndices.flatMap(index => {
      const match = text(row[index]).match(/(?:EkoCrop\s*)?(\d+(?:[.,]\d+)?)/i);
      return match ? [match[1].replace(",", ".")] : [];
    }));
    for (const release of rowReleases) counts.set(release, (counts.get(release) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) throw new Error("В колонке «Исправить в версиях» не указан релиз EkoCrop");
  if (ranked[1]?.[1] === ranked[0][1]) {
    throw new Error(`В CSV неоднозначно указаны релизы: ${ranked.filter(item => item[1] === ranked[0][1]).map(item => item[0]).join(", ")}`);
  }
  return ranked[0][0];
}

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
  const compactLinks = Array.isArray(raw.issueLinks) ? raw.issueLinks.map(link => link?.key) : [];
  const jiraLinks = Array.isArray(fields.issuelinks)
    ? fields.issuelinks.flatMap(link => [link.inwardIssue?.key, link.outwardIssue?.key])
    : [];
  return uniqueStrings([...direct, ...compactLinks, ...jiraLinks]);
}

function normalizeIssue(raw, jiraBaseUrl) {
  const fields = raw?.fields || raw || {};
  const key = text(raw?.key ?? fields.key);
  if (!key) throw new Error("В ответе Jira найдена задача без key");
  const components = uniqueStrings([raw.components, fields.components]);
  const parentKey = text(raw.parentKey ?? fields.parent?.key ?? raw.parent?.key);
  const links = linkedKeys(fields, raw).filter(link => link !== key);
  if (parentKey && !links.includes(parentKey)) links.unshift(parentKey);
  const relationTypes = {...(raw.relationTypes || {})};
  for (const link of Array.isArray(raw.issueLinks) ? raw.issueLinks : []) {
    const linkedKey = text(link?.key);
    const label = displayRelationName(link?.type);
    if (linkedKey && label) relationTypes[linkedKey] = uniqueStrings([relationTypes[linkedKey], label]);
  }
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
    relationTypes,
    parentKey,
    external: false,
    synthetic: false,
  };
}

function issueReleaseVersions(raw) {
  const fields = raw?.fields || raw || {};
  const source = [raw?.fixVersions, raw?.versions, fields.fixVersions];
  return uniqueStrings(source).flatMap(value => {
    const matches = [...String(value).matchAll(/EkoCrop\s+(\d+(?:[.,]\d+)*)/gi)];
    return matches.map(match => match[1].replace(",", "."));
  });
}

function validRelease(value) {
  return /^\d+(?:\.\d+)*$/.test(text(value));
}

function compareReleases(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference) return difference;
  }
  return left.localeCompare(right, "ru");
}

function issuesForRelease(rawIssues, release, jiraBaseUrl) {
  const normalized = rawIssues.map(raw => ({raw, issue: normalizeIssue(raw, jiraBaseUrl)}));
  const byKey = new Map(normalized.map(item => [item.issue.id, item]));
  const selected = new Map();
  for (const item of normalized) {
    if (issueReleaseVersions(item.raw).includes(release)) selected.set(item.issue.id, item.raw);
  }

  // Проекты могут не иметь версии сами, но должны попасть в релиз,
  // если с ними структурно связана хотя бы одна задача этого релиза.
  const queue = [...selected.keys()];
  const visited = new Set(queue);
  while (queue.length) {
    const key = queue.shift();
    const item = byKey.get(key);
    if (!item) continue;
    for (const linkedKey of uniqueStrings([item.issue.parentKey, item.issue.links])) {
      if (visited.has(linkedKey)) continue;
      const linked = byKey.get(linkedKey);
      if (!linked || !projectCandidate(linked.issue)) continue;
      visited.add(linkedKey);
      selected.set(linkedKey, linked.raw);
      queue.push(linkedKey);
    }
  }
  return [...selected.values()];
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
  const relationPriority = candidate => {
    const labels = uniqueStrings([
      issue.relationTypes?.[candidate.id],
      candidate.relationTypes?.[issue.id],
    ]).map(label => label.toLowerCase());
    if (labels.includes("subtask")) return 3;
    if (labels.includes("epic")) return 2;
    if (labels.includes("relates")) return 0;
    return 1;
  };
  const linked = issue.links
    .map(key => candidates.get(key))
    .filter(Boolean)
    .sort((a, b) => relationPriority(b) - relationPriority(a) || candidateScore(b, issuesByKey) - candidateScore(a, issuesByKey));
  let selected = issue.parentKey ? candidates.get(issue.parentKey) : null;
  if (!selected) selected = linked[0] || null;
  const seen = new Set();
  while (selected && parentByProject.has(selected.id) && !seen.has(selected.id)) {
    seen.add(selected.id);
    selected = candidates.get(parentByProject.get(selected.id)) || selected;
  }
  return selected;
}

function relationLabelsFor(issue, project, candidates, parentByProject) {
  const belongsToProject = candidate => {
    const seen = new Set();
    let current = candidate;
    while (current && parentByProject.has(current.id) && !seen.has(current.id)) {
      seen.add(current.id);
      current = candidates.get(parentByProject.get(current.id)) || current;
    }
    return current?.id === project.id;
  };
  return uniqueStrings(issue.links.flatMap(linkedKey => {
    const candidate = candidates.get(linkedKey);
    if (!candidate || !belongsToProject(candidate)) return [];
    const labels = issue.relationTypes?.[linkedKey] || candidate.relationTypes?.[issue.id] || [];
    return uniqueStrings(labels).length || linkedKey !== issue.parentKey ? labels : ["subtask"];
  }));
}

function relationLabelFor(issue, project, candidates, parentByProject) {
  return relationLabelsFor(issue, project, candidates, parentByProject).join(", ");
}

function hasStructuralProjectRelation(issue, project, candidates, parentByProject) {
  return relationLabelsFor(issue, project, candidates, parentByProject).some(label => {
    const normalized = label.toLowerCase();
    return ["subtask", "subtasks-custom-link", "epic", "ссылка на эпик", "epics-custom-link"].includes(normalized);
  });
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
  for (const linkedKey of uniqueStrings(issues.flatMap(issue => issue.links))) {
    if (!linkedKey.startsWith("PROJECTS-") || issuesByKey.has(linkedKey)) continue;
    const externalProject = {
      id: linkedKey,
      summary: linkedKey,
      taskType: "Проект",
      status: "Вне выбранного релиза",
      priority: "Не указан",
      assignee: "Не назначен",
      url: `${jiraBaseUrl.replace(/\/$/, "")}/browse/${encodeURIComponent(linkedKey)}`,
      components: [],
      links: [],
      parentKey: "",
      external: true,
      synthetic: false,
    };
    issuesByKey.set(linkedKey, externalProject);
    candidates.set(linkedKey, externalProject);
  }
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
    if (project && taskBuckets.has(project.id)) {
      issue.relationLabel = relationLabelFor(issue, project, candidates, parentByProject);
      taskBuckets.get(project.id).push(issue);
    }
    else unassigned.push(issue);
  }

  const visibleTopLevelProjects = topLevelProjects.filter(project => {
    if (!project.external) return true;
    return (taskBuckets.get(project.id) || []).some(issue => (
      hasStructuralProjectRelation(issue, project, candidates, parentByProject)
    ));
  });
  const visibleProjectIds = new Set(visibleTopLevelProjects.map(project => project.id));
  for (const project of topLevelProjects) {
    if (!visibleProjectIds.has(project.id)) unassigned.push(...(taskBuckets.get(project.id) || []));
  }

  const groups = visibleTopLevelProjects.map(project => ({group: project, tasks: taskBuckets.get(project.id) || [], synthetic: false}));
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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://nykval.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  Vary: "Origin",
};

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: {"Cache-Control": "no-store", ...CORS_HEADERS},
  });
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function readPayload(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 50 * 1024 * 1024) throw new Error("Тело запроса больше 50 МБ");
  return request.json();
}

function requireBindings(env) {
  if (!env.JOBS) throw new Error("Cloudflare KV binding JOBS не настроен");
}

async function startJob(request, env) {
  requireBindings(env);
  const payload = await readPayload(request);
  const release = text(payload.release);
  if (!validRelease(release)) return json({error: "Выберите синхронизированный релиз EkoCrop"}, 400);

  const snapshot = await env.JOBS.get(`${SNAPSHOT_PREFIX}${release}`);
  if (snapshot) {
    const stored = JSON.parse(snapshot);
    const id = crypto.randomUUID();
    const job = {id, release, status: "ready", createdAt: Date.now(), completedAt: stored.syncedAt, result: stored.result};
    await env.JOBS.put(`job:${id}`, JSON.stringify(job), {expirationTtl: JOB_TTL_SECONDS});
    return json({id, release, status: "ready", syncedAt: stored.syncedAt}, 201);
  }

  if (!env.JIRA_POLL_TOKEN) {
    return json({error: `Для релиза ${release} ещё нет данных. Дождитесь периодической синхронизации Jira`}, 404);
  }

  const id = crypto.randomUUID();
  const callbackToken = randomToken();
  const callbackUrl = `${new URL(request.url).origin}/api/jira-callback`;
  const job = {id, release, callbackToken, callbackUrl, status: "queued", createdAt: Date.now(), attempts: 0};
  await env.JOBS.put(`job:${id}`, JSON.stringify(job), {expirationTtl: JOB_TTL_SECONDS});
  return json({id, release, status: "queued"}, 202);
}

async function saveSnapshot(payload, env) {
  requireBindings(env);
  const issues = Array.isArray(payload) ? payload : payload.issues;
  if (!Array.isArray(issues)) return json({error: "Jira должна передать массив issues"}, 400);

  const jiraBaseUrl = env.JIRA_BASE_URL || "https://dev.ekoniva-apk.com";
  const syncedAt = new Date().toISOString();
  const previousMetaRaw = await env.JOBS.get("snapshot:meta");
  const previousMeta = previousMetaRaw ? JSON.parse(previousMetaRaw) : null;
  const releases = [...new Set(issues.flatMap(issueReleaseVersions))].sort(compareReleases);
  const saved = [];
  for (const release of releases) {
    const releaseIssues = issuesForRelease(issues, release, jiraBaseUrl);
    if (!releaseIssues.length) {
      await env.JOBS.delete?.(`${SNAPSHOT_PREFIX}${release}`);
      continue;
    }
    const result = buildDiagramData(release, releaseIssues, jiraBaseUrl);
    await env.JOBS.put(`${SNAPSHOT_PREFIX}${release}`, JSON.stringify({release, syncedAt, result}));
    saved.push({release, issues: result.data.summary.releaseIssues});
  }
  const currentReleases = new Set(releases);
  for (const item of previousMeta?.releases || []) {
    if (!currentReleases.has(item.release)) await env.JOBS.delete?.(`${SNAPSHOT_PREFIX}${item.release}`);
  }
  await env.JOBS.put("snapshot:meta", JSON.stringify({syncedAt, receivedIssues: issues.length, releases: saved}));
  return json({ok: true, syncedAt, receivedIssues: issues.length, releases: saved});
}

async function acceptSnapshot(request, env) {
  return saveSnapshot(await readPayload(request), env);
}

async function availableReleases(env) {
  if (!env.JOBS) return DEFAULT_RELEASES.map(name => ({id: name, name, available: false}));
  const metaRaw = await env.JOBS.get("snapshot:meta");
  const meta = metaRaw ? JSON.parse(metaRaw) : null;
  if (!meta) return DEFAULT_RELEASES.map(name => ({id: name, name, available: false}));
  return (meta.releases || [])
    .map(item => ({id: item.release, name: item.release, available: true, issueCount: item.issues}))
    .sort((left, right) => compareReleases(left.name, right.name));
}

function pollAuthorized(request, env) {
  const expected = text(env.JIRA_POLL_TOKEN);
  const received = text(request.headers.get("X-Jira-Poll-Token"));
  return Boolean(expected && received && received === expected);
}

async function claimJob(request, env) {
  requireBindings(env);
  if (!env.JIRA_POLL_TOKEN) return json({error: "Секрет JIRA_POLL_TOKEN не настроен"}, 503);
  if (!pollAuthorized(request, env)) return json({error: "Неверный токен Jira dispatcher"}, 401);

  const now = Date.now();
  const listed = await env.JOBS.list({prefix: "job:", limit: 1000});
  const candidates = [];
  for (const key of listed.keys || []) {
    const stored = await env.JOBS.get(key.name);
    if (!stored) continue;
    const job = JSON.parse(stored);
    const retryable = job.status === "processing" && now - Number(job.claimedAt || 0) >= CLAIM_RETRY_MS;
    if (job.status === "queued" || retryable) candidates.push(job);
  }
  candidates.sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
  const job = candidates[0];
  if (!job) return json({pending: false});

  job.status = "processing";
  job.claimedAt = now;
  job.attempts = Number(job.attempts || 0) + 1;
  await env.JOBS.put(`job:${job.id}`, JSON.stringify(job), {expirationTtl: JOB_TTL_SECONDS});
  return json({
    pending: true,
    requestId: job.id,
    releaseVersion: job.release,
    callbackToken: job.callbackToken,
    callbackUrl: job.callbackUrl,
    attempt: job.attempts,
  });
}

async function acceptCallback(request, env) {
  requireBindings(env);
  const payload = await readPayload(request);
  const id = text(payload.requestId);
  const issues = Array.isArray(payload) ? payload : payload.issues;
  if (!id && Array.isArray(issues)) return saveSnapshot(payload, env);
  const token = text(payload.callbackToken);
  const stored = id && await env.JOBS.get(`job:${id}`);
  if (!stored) return json({error: "Запрос не найден или устарел"}, 404);
  const job = JSON.parse(stored);
  if (token !== job.callbackToken) return json({error: "Неверный callback token"}, 403);
  if (job.status === "ready") return json({error: "Результат для этого запроса уже получен"}, 409);
  try {
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

async function importCsv(request, env) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 5 * 1024 * 1024) return json({error: "CSV-файл больше 5 МБ"}, 413);
  const csvText = await request.text();
  const release = jiraCsvRelease(csvText);
  const issues = jiraCsvToIssues(csvText);
  return json(buildDiagramData(release, issues, env.JIRA_BASE_URL || "https://dev.ekoniva-apk.com"));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
        return new Response(null, {status: 204, headers: CORS_HEADERS});
      }
      if (request.method === "GET" && url.pathname === "/api/releases") {
        return json({releases: await availableReleases(env), mode: env.JOBS ? "jira-snapshot" : env.JIRA_POLL_TOKEN ? "jira-polling" : "not-configured"});
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ok: true, platform: "cloudflare-workers", integration: env.JOBS ? "jira-snapshot" : env.JIRA_POLL_TOKEN ? "jira-polling" : "not-configured", storage: env.JOBS ? "ready" : "not-configured"});
      }
      if (request.method === "POST" && url.pathname === "/api/diagram-jobs") return startJob(request, env);
      if (request.method === "POST" && url.pathname === "/api/jira-snapshot") return acceptSnapshot(request, env);
      if (request.method === "POST" && url.pathname === "/api/jira-poll") return claimJob(request, env);
      if (request.method === "POST" && url.pathname === "/api/import-csv") return importCsv(request, env);
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
