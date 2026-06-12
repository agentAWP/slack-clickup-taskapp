const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { mkdtemp, rm } = require("node:fs/promises");
const { after, before, test } = require("node:test");

let app;
let appBaseUrl;
let mockServer;
let tempDir;

const tasks = {
  active: {
    id: "active",
    name: "Active task",
    status: { status: "to do", type: "open" },
    due_date: null,
    assignees: [{ id: 1, username: "Thomas" }],
    archived: false,
    url: "https://app.clickup.com/t/active",
    list: { id: "list-1" }
  },
  closed: {
    id: "closed",
    name: "Closed task",
    status: { status: "complete", type: "closed" },
    due_date: null,
    assignees: [],
    archived: false,
    url: "https://app.clickup.com/t/closed",
    list: { id: "list-1" }
  },
  foreign: {
    id: "foreign",
    name: "Foreign task",
    status: { status: "to do", type: "open" },
    due_date: null,
    assignees: [],
    archived: false,
    url: "https://app.clickup.com/t/foreign",
    list: { id: "other-list" }
  }
};

before(async () => {
  mockServer = http.createServer(handleMockClickUpRequest);
  await listen(mockServer);
  const mockPort = mockServer.address().port;

  const appPort = await getAvailablePort();
  appBaseUrl = `http://127.0.0.1:${appPort}`;
  tempDir = await mkdtemp(path.join(os.tmpdir(), "taskapp-tests-"));
  app = spawn(process.execPath, ["src/server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(appPort),
      APP_BASE_URL: appBaseUrl,
      DATA_FILE: path.join(tempDir, "connections.json"),
      CLICKUP_API_BASE: `http://127.0.0.1:${mockPort}`,
      CLICKUP_TOKEN: "pk_test",
      CLICKUP_LIST_ID: "list-1",
      CLICKUP_ASSIGNEE_ALIASES: "thomas:1,princess:2",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "test-signing-secret",
      TASKAPP_ADMIN_KEY: "test-admin"
    },
    stdio: "ignore"
  });
  await waitForServer(`${appBaseUrl}/health`);
});

after(async () => {
  app?.kill("SIGTERM");
  await close(mockServer);
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("task endpoints require the admin key", async () => {
  const response = await fetch(`${appBaseUrl}/api/tasks?connectionId=env-fallback`);
  assert.equal(response.status, 401);
});

test("lists active tasks and task metadata", async () => {
  const response = await adminFetch("/api/tasks?connectionId=env-fallback&page=0");
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(data.tasks.map((task) => task.id), ["active"]);
  assert.deepEqual(data.statuses.map((status) => status.name), ["to do", "in progress", "complete"]);
  assert.deepEqual(data.assignees.map((member) => member.username), ["Princess", "Thomas"]);
});

test("signed Slack list command returns active tasks", async () => {
  const body = new URLSearchParams({
    command: "/taskapp",
    text: "list",
    team_id: "team-1",
    channel_id: "channel-1",
    user_id: "user-1"
  }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${crypto.createHmac("sha256", "test-signing-secret")
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  const response = await fetch(`${appBaseUrl}/slack/commands/clickup-task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature
    },
    body
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.match(data.text, /Active ClickUp tasks \(1\)/);
  assert.match(data.text, /Active task/);
  assert.doesNotMatch(data.text, /Closed task/);
});

test("updates title, due date, assignees, and status", async () => {
  const response = await adminFetch("/api/tasks/active", {
    method: "PATCH",
    body: JSON.stringify({
      connectionId: "env-fallback",
      name: "Updated task",
      due: "2026-06-15",
      assignees: [2],
      status: "in progress"
    })
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.task.name, "Updated task");
  assert.equal(data.task.status, "in progress");
  assert.deepEqual(data.task.assignees.map((assignee) => assignee.id), [2]);
  assert.ok(data.task.dueDate);
});

test("rejects invalid statuses and tasks from another List", async () => {
  const invalidStatus = await adminFetch("/api/tasks/active", {
    method: "PATCH",
    body: JSON.stringify({ connectionId: "env-fallback", status: "made up" })
  });
  assert.equal(invalidStatus.status, 400);

  const foreignTask = await adminFetch("/api/tasks/foreign", {
    method: "PATCH",
    body: JSON.stringify({ connectionId: "env-fallback", name: "Not allowed" })
  });
  assert.equal(foreignTask.status, 403);
});

test("permanently deletes a task", async () => {
  const response = await adminFetch("/api/tasks/active?connectionId=env-fallback", { method: "DELETE" });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.deletedTask.id, "active");
  assert.equal(tasks.active, undefined);
});

function adminFetch(apiPath, options = {}) {
  return fetch(`${appBaseUrl}${apiPath}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-TaskApp-Admin-Key": "test-admin",
      ...(options.headers || {})
    }
  });
}

function handleMockClickUpRequest(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET" && url.pathname === "/list/list-1/task") {
    return res.end(JSON.stringify({ tasks: [tasks.active, tasks.closed].filter(Boolean) }));
  }
  if (req.method === "GET" && url.pathname === "/list/list-1") {
    return res.end(JSON.stringify({
      id: "list-1",
      name: "Demo List",
      statuses: [
        { status: "to do", type: "open", orderindex: 0 },
        { status: "in progress", type: "custom", orderindex: 1 },
        { status: "complete", type: "closed", orderindex: 2 }
      ]
    }));
  }
  if (req.method === "GET" && url.pathname === "/list/list-1/member") {
    return res.end(JSON.stringify({ members: [{ id: 1, username: "Thomas" }, { id: 2, username: "Princess" }] }));
  }

  const taskMatch = url.pathname.match(/^\/task\/(.+)$/);
  if (taskMatch && req.method === "GET") {
    const task = tasks[taskMatch[1]];
    if (!task) return sendMockError(res, 404, "not found");
    return res.end(JSON.stringify(task));
  }
  if (taskMatch && req.method === "PUT") {
    return readJson(req).then((body) => {
      const task = tasks[taskMatch[1]];
      if (!task) return sendMockError(res, 404, "not found");
      if (body.name) task.name = body.name;
      if (Object.prototype.hasOwnProperty.call(body, "due_date")) task.due_date = body.due_date;
      if (body.status) task.status = { status: body.status, type: body.status === "complete" ? "closed" : "custom" };
      if (body.assignees) {
        const remaining = task.assignees.map((assignee) => Number(assignee.id))
          .filter((id) => !body.assignees.rem.includes(id));
        const ids = [...new Set(remaining.concat(body.assignees.add))];
        task.assignees = ids.map((id) => ({ id, username: id === 1 ? "Thomas" : "Princess" }));
      }
      res.end(JSON.stringify(task));
    });
  }
  if (taskMatch && req.method === "DELETE") {
    delete tasks[taskMatch[1]];
    res.statusCode = 204;
    return res.end();
  }

  return sendMockError(res, 404, "unknown route");
}

function sendMockError(res, status, error) {
  res.statusCode = status;
  res.end(JSON.stringify({ err: error }));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(JSON.parse(body || "{}")));
    req.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function getAvailablePort() {
  const server = http.createServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  return port;
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("TaskApp test server did not start.");
}
