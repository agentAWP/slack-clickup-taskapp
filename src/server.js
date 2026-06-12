const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const DATA_FILE = process.env.DATA_FILE || path.join(process.cwd(), "data", "connections.json");
const CLICKUP_API_BASE = process.env.CLICKUP_API_BASE || "https://api.clickup.com/api/v2";
const SLACK_API_BASE = "https://slack.com/api";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      return sendJson(res, 200, {
        ok: true,
        app: "Slack to ClickUp Tasker",
        endpoints: [
          "GET /setup",
          "GET /health",
          "GET /demo",
          "POST /api/run-demo",
          "POST /api/test-connection",
          "POST /api/create-clickup-task",
          "GET /api/tasks",
          "PATCH /api/tasks/:taskId",
          "DELETE /api/tasks/:taskId",
          "POST /slack/commands/clickup-task"
        ]
      });
    }

    if (req.method === "GET" && url.pathname === "/setup") {
      return sendHtml(res, 200, renderSetupPage(url));
    }

    if (req.method === "GET" && url.pathname === "/setup/slack/install") {
      return redirect(res, buildSlackInstallUrl());
    }

    if (req.method === "GET" && url.pathname === "/oauth/slack/callback") {
      const result = await handleSlackOAuthCallback(url);
      if (result.ok) return redirect(res, "/setup?tab=connections&connected=slack");
      return sendHtml(res, result.ok ? 200 : 400, renderOAuthResult("Slack", result));
    }

    if (req.method === "GET" && url.pathname === "/setup/clickup/connect") {
      return redirect(res, buildClickUpInstallUrl(url.searchParams.get("connectionId")));
    }

    if (req.method === "GET" && url.pathname === "/oauth/clickup/callback") {
      const result = await handleClickUpOAuthCallback(url);
      if (result.ok) return redirect(res, "/setup?tab=connections&connected=clickup");
      return sendHtml(res, result.ok ? 200 : 400, renderOAuthResult("ClickUp", result));
    }

    if (req.method === "POST" && url.pathname === "/setup/connections") {
      const rawBody = await readBody(req);
      const form = new URLSearchParams(rawBody);
      const assigneeAliases = mergeAliasText(
        form.get("assigneeAliases"),
        form.getAll("selectedAssigneeAliases")
      );
      const result = saveConnectionSettings({
        connectionId: form.get("connectionId"),
        name: form.get("name"),
        clickupListId: form.get("clickupListId"),
        assigneeAliases,
        defaultSlackChannelId: form.get("defaultSlackChannelId")
      });

      if (!result.ok) {
        if (wantsJson(req)) return sendJson(res, 400, result);
        return sendHtml(res, 400, renderOAuthResult("Connection settings", result));
      }

      if (wantsJson(req)) {
        return sendJson(res, 200, {
          ok: true,
          message: "Connection settings saved.",
          connection: result.connection
        });
      }

      return redirect(res, "/setup?tab=connections&saved=1");
    }

    if (req.method === "POST" && url.pathname === "/setup/refresh-options") {
      const rawBody = await readBody(req);
      const form = new URLSearchParams(rawBody);
      const result = await refreshConnectionOptions(form.get("connectionId"));

      if (!result.ok) {
        return sendHtml(res, 400, renderOAuthResult("Refresh options", result));
      }

      return redirect(res, "/setup?tab=connections&refreshed=1");
    }

    if (req.method === "POST" && url.pathname === "/setup/reset") {
      saveConnectionStore({ connections: [] });
      return redirect(res, "/setup?tab=demo-tools&reset=1");
    }

    if (req.method === "GET" && url.pathname === "/demo") {
      const store = loadConnectionStore();
      return sendJson(res, 200, {
        ok: true,
        app: "Slack to ClickUp Tasker",
        purpose: "Create ClickUp tasks from a Slack slash command.",
        setup: {
          inProductSetupUrl: `${APP_BASE_URL}/setup`,
          runtimeConnections: store.connections.length,
          connectionStorage: DATA_FILE
        },
        sampleCommand: "/taskapp Review FDE submission | assign: jay | tags: demo,interview | priority: high | due: tomorrow",
        workflow: [
          "Slack sends a signed slash-command webhook to this app.",
          "The app verifies the Slack request signature.",
          "The app resolves the runtime connection for the Slack team.",
          "The app parses task name, assignees, tags, priority, due date, and description.",
          "The app creates a task in the configured ClickUp List.",
          "The app returns one ephemeral Slack confirmation with the ClickUp task URL."
        ],
        endpoints: {
          setup: "GET /setup",
          health: "GET /health",
          demo: "GET /demo",
          runDemo: "POST /api/run-demo",
          testConnection: "POST /api/test-connection",
          directWorkflowTest: "POST /api/create-clickup-task",
          activeTasks: "GET /api/tasks?connectionId=...&page=0",
          updateTask: "PATCH /api/tasks/:taskId",
          deleteTask: "DELETE /api/tasks/:taskId?connectionId=...",
          slackSlashCommand: "POST /slack/commands/clickup-task"
        },
        commandSyntax: {
          command: "/taskapp",
          format: "/taskapp Task name | assign: jay | tags: bug,auth | priority: high | due: tomorrow | description: details",
          list: "/taskapp list",
          assignees: "Use ClickUp user IDs directly or aliases configured in /setup.",
          tags: "Comma-separated tags. The app always includes the default slack tag.",
          priorities: ["urgent", "high", "normal", "low"],
          dueDateExamples: ["today", "tomorrow", "2026-06-10"]
        }
      });
    }

    if (req.method === "POST" && url.pathname === "/api/run-demo") {
      const connection = buildEnvConnection();
      const result = await runTaskWorkflow({
        taskName: "TaskApp fallback demo task",
        description: "Created from the Run Demo fallback endpoint.",
        priority: "high",
        due: "tomorrow",
        assignees: "",
        tags: ["demo", "fallback"],
        source: "run_demo",
        postSlackConfirmation: true,
        connection
      });

      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/test-connection") {
      const body = await readBody(req);
      const payload = body ? parseJson(body) : {};
      const connection = findConnectionForRequest({
        connectionId: payload.connectionId,
        teamId: payload.teamId,
        allowDefault: true
      });
      const result = await runTaskWorkflow({
        taskName: payload.name || "TaskApp runtime connection test",
        description: "Created from the Test Runtime Connection endpoint.",
        priority: payload.priority || "normal",
        due: payload.due || "tomorrow",
        assignees: payload.assignees || payload.assignee,
        tags: payload.tags || ["runtime", "test"],
        slackChannelId: payload.channel,
        source: "test_connection",
        postSlackConfirmation: true,
        connection
      });

      return sendJson(res, 200, result);
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const store = loadConnectionStore();
      const fallback = buildEnvConnection();
      return sendJson(res, 200, {
        ok: true,
        appBaseUrl: APP_BASE_URL,
        dataFile: DATA_FILE,
        runtimeConnections: store.connections.length,
        oauthConfigured: {
          slack: Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET && process.env.SLACK_SIGNING_SECRET),
          clickup: Boolean(process.env.CLICKUP_CLIENT_ID && process.env.CLICKUP_CLIENT_SECRET)
        },
        fallbackConfigured: {
          clickup: Boolean(fallback?.clickupToken && fallback?.clickupListId),
          slack: Boolean(fallback?.slackBotToken),
          slackSigning: Boolean(process.env.SLACK_SIGNING_SECRET)
        },
        taskManagementAdminConfigured: Boolean(process.env.TASKAPP_ADMIN_KEY)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/create-clickup-task") {
      const body = await readBody(req);
      const payload = parseJson(body);
      const connection = findConnectionForRequest({
        connectionId: payload.connectionId,
        teamId: payload.teamId,
        allowDefault: true
      });
      const result = await runTaskWorkflow({
        taskName: payload.name,
        description: payload.description,
        priority: payload.priority,
        due: payload.due,
        assignees: payload.assignees || payload.assignee,
        tags: payload.tags,
        slackChannelId: payload.channel,
        source: "api",
        connection
      });

      return sendJson(res, 200, result);
    }

    if (req.method === "GET" && url.pathname === "/api/tasks") {
      const auth = verifyTaskAdminRequest(req);
      if (!auth.ok) return sendJson(res, auth.status, auth);

      const connection = findConnectionForRequest({
        connectionId: url.searchParams.get("connectionId"),
        allowDefault: true
      });
      const page = parseTaskPage(url.searchParams.get("page"));
      if (page === null) return sendJson(res, 400, { ok: false, error: "Page must be a non-negative integer." });

      const result = await listActiveTasks({ connection, page });
      return sendJson(res, result.ok ? 200 : result.status || 502, result);
    }

    const taskRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskRoute && req.method === "PATCH") {
      const auth = verifyTaskAdminRequest(req);
      if (!auth.ok) return sendJson(res, auth.status, auth);

      const payload = parseJson(await readBody(req));
      const connection = findConnectionForRequest({
        connectionId: payload.connectionId,
        allowDefault: true
      });
      const result = await updateManagedTask({
        connection,
        taskId: decodeURIComponent(taskRoute[1]),
        changes: payload
      });
      return sendJson(res, result.ok ? 200 : result.status || 502, result);
    }

    if (taskRoute && req.method === "DELETE") {
      const auth = verifyTaskAdminRequest(req);
      if (!auth.ok) return sendJson(res, auth.status, auth);

      const connection = findConnectionForRequest({
        connectionId: url.searchParams.get("connectionId"),
        allowDefault: true
      });
      const result = await deleteManagedTask({
        connection,
        taskId: decodeURIComponent(taskRoute[1])
      });
      return sendJson(res, result.ok ? 200 : result.status || 502, result);
    }

    if (req.method === "POST" && url.pathname === "/slack/commands/clickup-task") {
      const rawBody = await readBody(req);

      if (!verifySlackRequest(req, rawBody)) {
        return sendJson(res, 401, {
          response_type: "ephemeral",
          text: "Could not verify this Slack request."
        });
      }

      const form = new URLSearchParams(rawBody);
      const commandText = form.get("text") || "";
      const commandName = form.get("command") || "/taskapp";
      if (isHelpCommand(commandText)) {
        return sendJson(res, 200, {
          response_type: "ephemeral",
          text: buildUsageText(commandName)
        });
      }

      if (isListCommand(commandText)) {
        const connection = findConnectionForRequest({
          teamId: form.get("team_id"),
          allowDefault: false
        });
        const result = await listTasksForSlack(connection);
        return sendJson(res, 200, {
          response_type: "ephemeral",
          text: result.ok ? buildSlackTaskList(result) : `${result.error}\nSetup: ${APP_BASE_URL}/setup`,
          workflow: result
        });
      }

      const parsed = parseSlackCommand(commandText);

      if (!parsed.taskName) {
        return sendJson(res, 200, {
          response_type: "ephemeral",
          text: buildUsageText(commandName)
        });
      }

      const connection = findConnectionForRequest({
        teamId: form.get("team_id"),
        allowDefault: false
      });

      const result = await runTaskWorkflow({
        taskName: parsed.taskName,
        description: parsed.description || `Created from Slack by ${form.get("user_name") || form.get("user_id") || "unknown user"}.`,
        priority: parsed.priority,
        due: parsed.due,
        assignees: parsed.assignees,
        tags: parsed.tags,
        slackChannelId: form.get("channel_id"),
        source: "slack_command",
        slackUserId: form.get("user_id"),
        postSlackConfirmation: false,
        connection
      });

      return sendJson(res, 200, {
        response_type: "ephemeral",
        text: result.ok
          ? buildSlackConfirmation(result)
          : `${result.error}\nSetup: ${APP_BASE_URL}/setup`,
        workflow: result
      });
    }

    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: "Unexpected server error",
      detail: error.message
    });
  }
});

server.listen(PORT, () => {
  console.log(`Slack ClickUp tasker listening on http://localhost:${PORT}`);
});

async function runTaskWorkflow(input) {
  const validationError = validateWorkflowInput(input);
  if (validationError) {
    return { ok: false, source: input.source, error: validationError };
  }

  const assignees = resolveClickUpAssignees(input.assignees, input.connection.assigneeAliases);
  if (!assignees.ok) {
    return { ok: false, source: input.source, error: assignees.error };
  }

  const tags = normalizeTags(input.tags);
  const slackChannelId = input.slackChannelId || input.connection.defaultSlackChannelId;

  try {
    const clickupTask = await createClickUpTask(input, {
      assigneeIds: assignees.ids,
      tags
    });
    const slackMessage = input.postSlackConfirmation === false
      ? { skipped: true, reason: "Slash command response is used as the Slack confirmation." }
      : await postSlackMessage({
        connection: input.connection,
        channel: slackChannelId,
        text: [
          `ClickUp task created: ${clickupTask.name}`,
          clickupTask.url,
          assignees.labels.length ? `Assigned to: ${assignees.labels.join(", ")}` : null,
          tags.length ? `Tags: ${tags.join(", ")}` : null,
          `Priority: ${normalizePriority(input.priority).label}`
        ].filter(Boolean).join("\n")
      });

    return {
      ok: true,
      source: input.source,
      connection: sanitizeConnection(input.connection),
      requested: {
        taskName: input.taskName,
        priority: normalizePriority(input.priority).label,
        due: input.due || null,
        assignees: assignees.labels,
        tags,
        slackChannelId: slackChannelId || null
      },
      clickupTask,
      slackMessage
    };
  } catch (error) {
    return {
      ok: false,
      source: input.source,
      connection: sanitizeConnection(input.connection),
      error: error.message
    };
  }
}

function validateWorkflowInput(input) {
  if (!input.connection) return "No integration connection found. Connect Slack and ClickUp in the setup page.";
  if (!input.connection.clickupToken) return "Missing ClickUp token for this connection.";
  if (!input.connection.clickupListId) return "Missing ClickUp List ID for this connection.";
  if (!input.connection.slackBotToken) return "Missing Slack bot token for this connection.";
  if (!input.taskName || !input.taskName.trim()) return "Missing task name.";
  return null;
}

async function createClickUpTask(input, options = {}) {
  const priority = normalizePriority(input.priority);
  const body = {
    name: input.taskName.trim(),
    description: input.description || "Created by the Slack to ClickUp integration.",
    priority: priority.value,
    tags: mergeTags(["slack"], options.tags)
  };

  if (options.assigneeIds?.length) body.assignees = options.assigneeIds;

  const dueDate = parseDueDate(input.due);
  if (dueDate) body.due_date = dueDate;

  const response = await fetch(`${CLICKUP_API_BASE}/list/${input.connection.clickupListId}/task`, {
    method: "POST",
    headers: {
      Authorization: input.connection.clickupToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`ClickUp API error (${response.status}): ${data.err || data.error || response.statusText}`);
  }

  return {
    id: data.id,
    name: data.name,
    assignees: Array.isArray(data.assignees)
      ? data.assignees.map((assignee) => ({
        id: assignee.id,
        username: assignee.username || assignee.email || null
      }))
      : [],
    tags: Array.isArray(data.tags)
      ? data.tags.map((tag) => tag.name || tag).filter(Boolean)
      : [],
    status: data.status?.status || null,
    url: data.url || null
  };
}

async function listActiveTasks({ connection, page }) {
  const validationError = validateTaskManagementConnection(connection);
  if (validationError) return { ok: false, status: 400, error: validationError };

  const query = new URLSearchParams({
    archived: "false",
    include_closed: "false",
    page: String(page),
    order_by: "updated",
    reverse: "true"
  });

  const [tasksResponse, listResponse, membersResponse] = await Promise.all([
    clickUpRequest(connection, "GET", `/list/${connection.clickupListId}/task?${query}`),
    clickUpRequest(connection, "GET", `/list/${connection.clickupListId}`),
    clickUpRequest(connection, "GET", `/list/${connection.clickupListId}/member`)
  ]);

  const failed = [tasksResponse, listResponse, membersResponse].find((response) => !response.ok);
  if (failed) return failed;

  const rawTasks = tasksResponse.data.tasks || [];
  const tasks = rawTasks
    .filter(Boolean)
    .map(normalizeManagedTask)
    .filter((task) => !task.archived && task.statusType !== "closed");
  return {
    ok: true,
    connection: sanitizeConnection(connection),
    list: {
      id: String(connection.clickupListId),
      name: listResponse.data.name || null
    },
    tasks,
    statuses: normalizeClickUpStatuses(listResponse.data.statuses),
    assignees: normalizeClickUpMembers(membersResponse.data),
    page,
    hasMore: rawTasks.length === 100
  };
}

async function listTasksForSlack(connection) {
  const validationError = validateTaskManagementConnection(connection);
  if (validationError) return { ok: false, source: "slack_list", error: validationError };

  const tasks = [];
  const maxPages = 10;
  let page = 0;
  let hasMore = true;

  while (hasMore && page < maxPages) {
    const query = new URLSearchParams({
      archived: "false",
      include_closed: "false",
      page: String(page),
      order_by: "updated",
      reverse: "true"
    });
    const response = await clickUpRequest(
      connection,
      "GET",
      `/list/${connection.clickupListId}/task?${query}`
    );
    if (!response.ok) return { ...response, source: "slack_list" };

    const rawTasks = response.data.tasks || [];
    tasks.push(...rawTasks
      .filter(Boolean)
      .map(normalizeManagedTask)
      .filter((task) => !task.archived && task.statusType !== "closed"));
    hasMore = rawTasks.length === 100;
    page += 1;
  }

  return {
    ok: true,
    source: "slack_list",
    connection: sanitizeConnection(connection),
    tasks,
    truncatedByPageLimit: hasMore
  };
}

async function updateManagedTask({ connection, taskId, changes }) {
  const validationError = validateTaskManagementConnection(connection);
  if (validationError) return { ok: false, status: 400, error: validationError };
  if (!taskId) return { ok: false, status: 400, error: "Missing task ID." };

  const currentResponse = await clickUpRequest(connection, "GET", `/task/${encodeURIComponent(taskId)}`);
  if (!currentResponse.ok) return currentResponse;
  const currentTask = currentResponse.data;
  const membershipError = validateTaskListMembership(currentTask, connection);
  if (membershipError) return { ok: false, status: 403, error: membershipError };

  const body = {};
  if (Object.prototype.hasOwnProperty.call(changes, "name")) {
    const name = String(changes.name || "").trim();
    if (!name) return { ok: false, status: 400, error: "Task title cannot be empty." };
    body.name = name;
  }

  if (Object.prototype.hasOwnProperty.call(changes, "due")) {
    if (changes.due === null || String(changes.due).trim() === "") {
      body.due_date = null;
    } else {
      const dueDate = parseManagedDueDate(changes.due);
      if (dueDate === null) {
        return { ok: false, status: 400, error: "Due date must be today, tomorrow, or YYYY-MM-DD." };
      }
      body.due_date = dueDate;
      body.due_date_time = false;
    }
  }

  if (Object.prototype.hasOwnProperty.call(changes, "status")) {
    const listResponse = await clickUpRequest(connection, "GET", `/list/${connection.clickupListId}`);
    if (!listResponse.ok) return listResponse;
    const statuses = normalizeClickUpStatuses(listResponse.data.statuses);
    const requestedStatus = String(changes.status || "").trim().toLowerCase();
    const status = statuses.find((item) => item.name.toLowerCase() === requestedStatus);
    if (!status) {
      return {
        ok: false,
        status: 400,
        error: `Unknown status "${changes.status}". Valid statuses: ${statuses.map((item) => item.name).join(", ")}.`
      };
    }
    body.status = status.name;
  }

  if (Object.prototype.hasOwnProperty.call(changes, "assignees")) {
    const desired = resolveClickUpAssignees(changes.assignees, connection.assigneeAliases);
    if (!desired.ok) return { ok: false, status: 400, error: desired.error };
    const currentIds = (currentTask.assignees || []).map((assignee) => Number(assignee.id)).filter(Number.isFinite);
    body.assignees = {
      add: desired.ids.filter((id) => !currentIds.includes(id)),
      rem: currentIds.filter((id) => !desired.ids.includes(id))
    };
  }

  if (!Object.keys(body).length) {
    return { ok: false, status: 400, error: "Provide at least one field to update: name, due, assignees, or status." };
  }

  const updateResponse = await clickUpRequest(
    connection,
    "PUT",
    `/task/${encodeURIComponent(taskId)}`,
    body
  );
  if (!updateResponse.ok) return updateResponse;

  return {
    ok: true,
    connection: sanitizeConnection(connection),
    requested: {
      name: body.name,
      due: Object.prototype.hasOwnProperty.call(body, "due_date") ? changes.due : undefined,
      assignees: Object.prototype.hasOwnProperty.call(changes, "assignees") ? normalizeList(changes.assignees) : undefined,
      status: body.status
    },
    task: normalizeManagedTask(updateResponse.data)
  };
}

async function deleteManagedTask({ connection, taskId }) {
  const validationError = validateTaskManagementConnection(connection);
  if (validationError) return { ok: false, status: 400, error: validationError };
  if (!taskId) return { ok: false, status: 400, error: "Missing task ID." };

  const currentResponse = await clickUpRequest(connection, "GET", `/task/${encodeURIComponent(taskId)}`);
  if (!currentResponse.ok) return currentResponse;
  const membershipError = validateTaskListMembership(currentResponse.data, connection);
  if (membershipError) return { ok: false, status: 403, error: membershipError };

  const deleteResponse = await clickUpRequest(connection, "DELETE", `/task/${encodeURIComponent(taskId)}`);
  if (!deleteResponse.ok) return deleteResponse;

  return {
    ok: true,
    connection: sanitizeConnection(connection),
    deletedTask: {
      id: String(taskId),
      name: currentResponse.data.name || null
    }
  };
}

function validateTaskManagementConnection(connection) {
  if (!connection) return "No integration connection found. Connect ClickUp in the setup page.";
  if (!connection.clickupToken) return "Missing ClickUp token for this connection.";
  if (!connection.clickupListId) return "Missing ClickUp List ID for this connection.";
  return null;
}

function validateTaskListMembership(task, connection) {
  const taskListId = task.list?.id;
  if (!taskListId || String(taskListId) !== String(connection.clickupListId)) {
    return "This task does not belong to the configured ClickUp List.";
  }
  return null;
}

function normalizeManagedTask(task) {
  return {
    id: String(task.id),
    name: task.name || "Untitled task",
    status: task.status?.status || null,
    statusType: task.status?.type || null,
    dueDate: task.due_date ? Number(task.due_date) : null,
    assignees: (task.assignees || []).map((assignee) => ({
      id: Number(assignee.id),
      username: assignee.username || assignee.email || String(assignee.id)
    })),
    archived: Boolean(task.archived),
    url: task.url || `https://app.clickup.com/t/${task.id}`
  };
}

function normalizeClickUpStatuses(statuses) {
  return (statuses || [])
    .filter((status) => status?.status)
    .map((status) => ({
      name: status.status,
      type: status.type || null,
      color: status.color || null,
      order: Number(status.orderindex || 0)
    }))
    .sort((a, b) => a.order - b.order);
}

function normalizeClickUpMembers(data) {
  return (data.members || data.users || [])
    .map((entry) => entry.user || entry)
    .filter((member) => member?.id)
    .map((member) => ({
      id: Number(member.id),
      username: member.username || member.email || member.name || String(member.id)
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

async function clickUpRequest(connection, method, apiPath, body) {
  try {
    const response = await fetch(`${CLICKUP_API_BASE}${apiPath}`, {
      method,
      headers: {
        Authorization: connection.clickupToken,
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      return {
        ok: false,
        status: [400, 401, 403, 404, 429].includes(response.status) ? response.status : 502,
        error: `ClickUp API error (${response.status}): ${data.err || data.error || response.statusText}${retryAfter ? `. Retry after ${retryAfter} seconds.` : ""}`
      };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, status: 502, error: `ClickUp request failed: ${error.message}` };
  }
}

async function postSlackMessage({ connection, channel, text }) {
  if (!channel) {
    return { skipped: true, reason: "No Slack channel provided." };
  }

  const response = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.slackBotToken}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({ channel, text })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.ok) {
    throw new Error(`Slack API error: ${data.error || response.statusText}`);
  }

  return {
    ok: true,
    channel: data.channel,
    ts: data.ts
  };
}

function findConnectionForRequest({ connectionId, teamId, allowDefault }) {
  const store = loadConnectionStore();
  const connections = store.connections.map(normalizeStoredConnection);

  if (connectionId) {
    const match = connections.find((connection) => connection.id === connectionId);
    if (match) return match;
    if (connectionId === "env-fallback") return buildEnvConnection();
    return null;
  }

  if (teamId) {
    const match = connections.find((connection) => connection.slackTeamId === teamId);
    if (match) return match;
  }

  if (allowDefault && connections.length) {
    return connections[0];
  }

  return buildEnvConnection();
}

function buildEnvConnection() {
  if (!process.env.CLICKUP_TOKEN || !process.env.CLICKUP_LIST_ID || !process.env.SLACK_BOT_TOKEN) {
    return null;
  }

  return {
    id: "env-fallback",
    name: "Environment fallback",
    source: "env",
    slackTeamId: null,
    slackTeamName: null,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    clickupToken: process.env.CLICKUP_TOKEN,
    clickupListId: process.env.CLICKUP_LIST_ID,
    assigneeAliases: process.env.CLICKUP_ASSIGNEE_ALIASES || "",
    defaultSlackChannelId: process.env.SLACK_DEFAULT_CHANNEL_ID || null,
    slackChannels: [],
    clickupLists: [],
    clickupMembers: []
  };
}

function loadConnectionStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { connections: [] };
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return { connections: Array.isArray(data.connections) ? data.connections : [] };
  } catch {
    return { connections: [] };
  }
}

function saveConnectionStore(store) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, `${JSON.stringify({ connections: store.connections }, null, 2)}\n`);
}

function upsertConnection(update) {
  const store = loadConnectionStore();
  const existingIndex = store.connections.findIndex((connection) =>
    connection.id === update.id ||
    (update.slackTeamId && connection.slackTeamId === update.slackTeamId)
  );
  const existing = existingIndex >= 0 ? store.connections[existingIndex] : {};
  const connection = {
    ...existing,
    ...update,
    id: existing.id || update.id || crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
    createdAt: existing.createdAt || new Date().toISOString()
  };

  if (existingIndex >= 0) {
    store.connections[existingIndex] = connection;
  } else {
    store.connections.push(connection);
  }

  saveConnectionStore(store);
  return normalizeStoredConnection(connection);
}

function normalizeStoredConnection(connection) {
  return {
    id: connection.id,
    name: connection.name || connection.slackTeamName || "Runtime connection",
    source: "runtime",
    slackTeamId: connection.slackTeamId || null,
    slackTeamName: connection.slackTeamName || null,
    slackBotToken: connection.slackBotToken || null,
    clickupToken: connection.clickupToken || null,
    clickupListId: connection.clickupListId || null,
    assigneeAliases: connection.assigneeAliases || "",
    defaultSlackChannelId: connection.defaultSlackChannelId || null,
    slackChannels: Array.isArray(connection.slackChannels) ? connection.slackChannels : [],
    clickupLists: Array.isArray(connection.clickupLists) ? connection.clickupLists : [],
    clickupMembers: Array.isArray(connection.clickupMembers) ? connection.clickupMembers : [],
    createdAt: connection.createdAt || null,
    updatedAt: connection.updatedAt || null
  };
}

function sanitizeConnection(connection) {
  if (!connection) return null;
  return {
    id: connection.id,
    name: connection.name,
    source: connection.source,
    slackTeamId: connection.slackTeamId,
    slackTeamName: connection.slackTeamName,
    clickupListId: connection.clickupListId,
    hasSlackBotToken: Boolean(connection.slackBotToken),
    hasClickUpToken: Boolean(connection.clickupToken),
    hasAssigneeAliases: Boolean(connection.assigneeAliases)
  };
}

function saveConnectionSettings({ connectionId, name, clickupListId, assigneeAliases, defaultSlackChannelId }) {
  if (!connectionId) return { ok: false, error: "Missing connectionId." };
  const connection = findConnectionForRequest({ connectionId, allowDefault: false });
  if (!connection || connection.source === "env") return { ok: false, error: "Runtime connection not found." };

  const updated = upsertConnection({
    id: connection.id,
    name: name || connection.name,
    clickupListId: clickupListId || connection.clickupListId,
    assigneeAliases: assigneeAliases || "",
    defaultSlackChannelId: defaultSlackChannelId || ""
  });

  return { ok: true, connection: sanitizeConnection(updated) };
}

async function refreshConnectionOptions(connectionId) {
  if (!connectionId) return { ok: false, error: "Missing connectionId." };
  const connection = findConnectionForRequest({ connectionId, allowDefault: false });
  if (!connection || connection.source === "env") return { ok: false, error: "Runtime connection not found." };

  const updates = { id: connection.id };
  const errors = [];

  if (connection.slackBotToken) {
    const channels = await fetchSlackChannels(connection);
    if (channels.ok) updates.slackChannels = channels.channels;
    else errors.push(channels.error);
  }

  if (connection.clickupToken) {
    const lists = await fetchClickUpLists(connection);
    if (lists.ok) updates.clickupLists = lists.lists;
    else errors.push(lists.error);

    const listId = connection.clickupListId || lists.lists?.[0]?.id;
    const workspaceMembers = await fetchClickUpWorkspaceMembers(connection);
    let allMembers = workspaceMembers.ok ? workspaceMembers.members : [];
    if (!workspaceMembers.ok) errors.push(workspaceMembers.error);

    if (listId) {
      const members = await fetchClickUpListMembers(connection, listId);
      if (members.ok) allMembers = mergeMembers(allMembers, members.members);
      else errors.push(members.error);
    }
    updates.clickupMembers = allMembers;
  }

  const updated = upsertConnection(updates);
  return {
    ok: errors.length === 0,
    message: errors.length ? errors.join(" ") : "Options refreshed.",
    error: errors.join(" "),
    connection: sanitizeConnection(updated)
  };
}

async function fetchSlackChannels(connection) {
  const response = await fetch(`${SLACK_API_BASE}/conversations.list?types=public_channel&exclude_archived=true&limit=200`, {
    headers: { Authorization: `Bearer ${connection.slackBotToken}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    return { ok: false, error: `Slack channel discovery failed: ${data.error || response.statusText}` };
  }

  return {
    ok: true,
    channels: (data.channels || [])
      .filter((channel) => channel.id && channel.name)
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        isMember: Boolean(channel.is_member)
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  };
}

async function fetchClickUpLists(connection) {
  const teamsResponse = await clickUpGet(connection, "/team");
  if (!teamsResponse.ok) return teamsResponse;

  const lists = [];
  for (const team of teamsResponse.data.teams || []) {
    const spaces = await clickUpGet(connection, `/team/${team.id}/space`);
    if (!spaces.ok) return spaces;

    for (const space of spaces.data.spaces || []) {
      const folderless = await clickUpGet(connection, `/space/${space.id}/list`);
      if (folderless.ok) {
        for (const list of folderless.data.lists || []) {
          lists.push({
            id: list.id,
            name: list.name,
            path: `${team.name} / ${space.name} / ${list.name}`
          });
        }
      }

      const folders = await clickUpGet(connection, `/space/${space.id}/folder`);
      if (!folders.ok) return folders;

      for (const folder of folders.data.folders || []) {
        const folderLists = await clickUpGet(connection, `/folder/${folder.id}/list`);
        if (!folderLists.ok) return folderLists;

        for (const list of folderLists.data.lists || []) {
          lists.push({
            id: list.id,
            name: list.name,
            path: `${team.name} / ${space.name} / ${folder.name} / ${list.name}`
          });
        }
      }
    }
  }

  return {
    ok: true,
    lists: lists.sort((a, b) => a.path.localeCompare(b.path))
  };
}

async function fetchClickUpListMembers(connection, listId) {
  const response = await clickUpGet(connection, `/list/${listId}/member`);
  if (!response.ok) return response;

  const rawMembers = response.data.members || response.data.users || [];
  const members = rawMembers
    .map((entry) => entry.user || entry)
    .filter((member) => member?.id)
    .map((member) => ({
      id: member.id,
      username: member.username || member.email || member.name || String(member.id),
      email: member.email || null,
      alias: makeAlias(member.username || member.email || member.name || String(member.id), member.id)
    }))
    .sort((a, b) => a.username.localeCompare(b.username));

  return { ok: true, members };
}

async function fetchClickUpWorkspaceMembers(connection) {
  const response = await clickUpGet(connection, "/team");
  if (!response.ok) return response;

  const members = [];
  for (const team of response.data.teams || []) {
    for (const entry of team.members || []) {
      const member = entry.user || entry;
      if (!member?.id) continue;
      members.push({
        id: member.id,
        username: member.username || member.email || member.name || String(member.id),
        email: member.email || null,
        alias: makeAlias(member.username || member.email || member.name || String(member.id), member.id)
      });
    }
  }

  return {
    ok: true,
    members: mergeMembers([], members)
  };
}

function mergeMembers(...memberGroups) {
  const byId = new Map();
  for (const member of memberGroups.flat()) {
    if (!member?.id) continue;
    byId.set(String(member.id), member);
  }
  return [...byId.values()].sort((a, b) => a.username.localeCompare(b.username));
}

async function clickUpGet(connection, apiPath) {
  const response = await fetch(`${CLICKUP_API_BASE}${apiPath}`, {
    headers: { Authorization: connection.clickupToken }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, error: `ClickUp discovery failed for ${apiPath}: ${data.err || data.error || response.statusText}` };
  }
  return { ok: true, data };
}

function buildSlackInstallUrl() {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) return "/setup?error=missing_slack_client_id";
  const authorizeUrl = new URL("https://slack.com/oauth/v2/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("scope", "commands,chat:write,channels:read,channels:join");
  authorizeUrl.searchParams.set("redirect_uri", `${APP_BASE_URL}/oauth/slack/callback`);
  return authorizeUrl.toString();
}

async function handleSlackOAuthCallback(url) {
  const code = url.searchParams.get("code");
  if (!code) return { ok: false, error: "Missing Slack OAuth code." };
  if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET) {
    return { ok: false, error: "Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET." };
  }

  const body = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    client_secret: process.env.SLACK_CLIENT_SECRET,
    code,
    redirect_uri: `${APP_BASE_URL}/oauth/slack/callback`
  });

  const response = await fetch(`${SLACK_API_BASE}/oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.ok) {
    return { ok: false, error: `Slack OAuth failed: ${data.error || response.statusText}` };
  }

  const connection = upsertConnection({
    name: data.team?.name || "Slack workspace",
    slackTeamId: data.team?.id,
    slackTeamName: data.team?.name,
    slackBotToken: data.access_token
  });

  return {
    ok: true,
    message: "Slack connected.",
    connection: sanitizeConnection(connection)
  };
}

function buildClickUpInstallUrl(connectionId) {
  const clientId = process.env.CLICKUP_CLIENT_ID;
  if (!clientId) return "/setup?error=missing_clickup_client_id";
  const authorizeUrl = new URL("https://app.clickup.com/api");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", `${APP_BASE_URL}/oauth/clickup/callback`);
  if (connectionId) authorizeUrl.searchParams.set("state", connectionId);
  return authorizeUrl.toString();
}

async function handleClickUpOAuthCallback(url) {
  const code = url.searchParams.get("code");
  const connectionId = url.searchParams.get("state");
  if (!code) return { ok: false, error: "Missing ClickUp OAuth code." };
  if (!process.env.CLICKUP_CLIENT_ID || !process.env.CLICKUP_CLIENT_SECRET) {
    return { ok: false, error: "Missing CLICKUP_CLIENT_ID or CLICKUP_CLIENT_SECRET." };
  }

  const response = await fetch(`${CLICKUP_API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.CLICKUP_CLIENT_ID,
      client_secret: process.env.CLICKUP_CLIENT_SECRET,
      code
    })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    return { ok: false, error: `ClickUp OAuth failed: ${data.err || data.error || response.statusText}` };
  }

  const store = loadConnectionStore();
  const fallbackId = store.connections[0]?.id || crypto.randomUUID();
  const connection = upsertConnection({
    id: connectionId || fallbackId,
    name: store.connections.find((item) => item.id === (connectionId || fallbackId))?.name || "Runtime connection",
    clickupToken: data.access_token
  });

  return {
    ok: true,
    message: "ClickUp connected. Add the ClickUp List ID on the setup page.",
    connection: sanitizeConnection(connection)
  };
}

function renderSetupPage(url) {
  const store = loadConnectionStore();
  const connections = store.connections.map(normalizeStoredConnection);
  const fallback = buildEnvConnection();
  const taskConnections = [...connections];
  if (fallback) taskConnections.push(fallback);
  const error = url.searchParams.get("error");
  const saved = url.searchParams.get("saved");
  const reset = url.searchParams.get("reset");
  const refreshed = url.searchParams.get("refreshed");
  const activeTab = normalizeSetupTab(url.searchParams.get("tab"));
  const connected = url.searchParams.get("connected");
  const connectedLabel = connected === "slack" ? "Slack" : connected === "clickup" ? "ClickUp" : null;

  return htmlPage("TaskApp Setup", `
    <header class="page-header">
      <div>
        <h1>TaskApp</h1>
        <p>Slack command to ClickUp task workflow.</p>
      </div>
      <a class="button secondary" href="/demo">View Demo Metadata</a>
    </header>
    ${error ? `<p class="error">Setup error: ${escapeHtml(error)}</p>` : ""}
    ${saved ? `<p class="success">Connection settings saved.</p>` : ""}
    ${reset ? `<p class="success">Runtime connections cleared.</p>` : ""}
    ${refreshed ? `<p class="success">Options refreshed from Slack and ClickUp.</p>` : ""}
    ${connectedLabel ? `<p class="success">${connectedLabel} connected. Continue configuring this workflow connection below.</p>` : ""}

    <nav class="tabs" aria-label="Setup sections">
      <button type="button" class="${setupTabClass(activeTab, "workflow")}" data-tab="workflow">Workflow</button>
      <button type="button" class="${setupTabClass(activeTab, "connections")}" data-tab="connections">Connections</button>
      <button type="button" class="${setupTabClass(activeTab, "tasks")}" data-tab="tasks">Tasks</button>
      <button type="button" class="${setupTabClass(activeTab, "test")}" data-tab="test">Test</button>
      <button type="button" class="${setupTabClass(activeTab, "demo-tools")}" data-tab="demo-tools">Demo Tools</button>
    </nav>

    <section class="${setupPanelClass(activeTab, "workflow")}" id="workflow">
      <div class="workflow-heading">
        <div>
          <p class="eyebrow">Live integration workflow</p>
          <h2>From Slack command to ClickUp task</h2>
        </div>
        <span class="workflow-badge">Signed + OAuth connected</span>
      </div>
      <div class="workflow-diagram" aria-label="Slack to ClickUp workflow">
        <div class="workflow-step">
          <span class="step-number">1</span>
          <span class="step-app slack-app">Slack</span>
          <strong>User runs /taskapp</strong>
          <span>Task name, assignee, tags, priority, due date, and description.</span>
        </div>
        <div class="workflow-connector"><span>Signed webhook</span></div>
        <div class="workflow-step">
          <span class="step-number">2</span>
          <span class="step-app taskapp-app">TaskApp</span>
          <strong>Verify + resolve</strong>
          <span>Verify Slack signature and find the saved connection using the Slack team ID.</span>
        </div>
        <div class="workflow-connector"><span>Mapped task data</span></div>
        <div class="workflow-step">
          <span class="step-number">3</span>
          <span class="step-app clickup-app">ClickUp</span>
          <strong>Create the task</strong>
          <span>Use the connected ClickUp token, selected List, aliases, and tags.</span>
        </div>
        <div class="workflow-connector"><span>Task result</span></div>
        <div class="workflow-step">
          <span class="step-number">4</span>
          <span class="step-app slack-app">Slack</span>
          <strong>Confirm to the user</strong>
          <span>Return one ephemeral response with the task URL and action summary.</span>
        </div>
      </div>
      <div class="workflow-details">
        <div>
          <span class="detail-label">Input</span>
          <strong>Slack context</strong>
          <p><code>team_id</code>, <code>channel_id</code>, user, and command text</p>
        </div>
        <div>
          <span class="detail-label">Runtime mapping</span>
          <strong>Connection configuration</strong>
          <p>ClickUp List, default Slack channel, assignee aliases, and OAuth tokens</p>
        </div>
        <div>
          <span class="detail-label">Output</span>
          <strong>Action context</strong>
          <p>ClickUp task ID, URL, status, assignees, tags, and Slack confirmation</p>
        </div>
      </div>
    </section>

    <section class="${setupPanelClass(activeTab, "connections")}" id="connections">
      <div class="status-grid">
        ${renderStatusCard("Slack OAuth App", process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET)}
        ${renderStatusCard("Slack Signing", process.env.SLACK_SIGNING_SECRET)}
        ${renderStatusCard("ClickUp OAuth App", process.env.CLICKUP_CLIENT_ID && process.env.CLICKUP_CLIENT_SECRET)}
        ${renderStatusCard("Task Admin", process.env.TASKAPP_ADMIN_KEY, "Protects task query and mutations")}
        ${renderStatusCard("Workflow Connections", connections.length, `${connections.length} saved workflow connection${connections.length === 1 ? "" : "s"}`)}
        ${renderStatusCard("Env Fallback", fallback)}
      </div>
      <div class="card">
        <h2>Connect Integrations</h2>
        <p>
          <button type="button" onclick="openModal('slack-modal')">Install Slack</button>
          <button type="button" onclick="openModal('clickup-modal')">Connect ClickUp</button>
        </p>
        <details>
          <summary>OAuth redirect URLs</summary>
          <p class="muted">Slack: <code>${APP_BASE_URL}/oauth/slack/callback</code></p>
          <p class="muted">ClickUp: <code>${APP_BASE_URL}/oauth/clickup/callback</code></p>
        </details>
      </div>
      ${connections.length ? connections.map(renderConnectionForm).join("") : `<div class="card"><p>No runtime connections yet. Install Slack and connect ClickUp to create one.</p></div>`}
    </section>

    <section class="${setupPanelClass(activeTab, "tasks")}" id="tasks">
      <div class="task-toolbar">
        <div>
          <p class="eyebrow">ClickUp task management</p>
          <h2>Active Tasks</h2>
          <p class="muted">View and manage non-closed, non-archived tasks in the selected ClickUp List.</p>
        </div>
        <div class="task-toolbar-controls">
          <label>
            Connection
            <select id="task-connection">${renderTaskConnectionOptions(taskConnections)}</select>
          </label>
          <label>
            Admin key
            <input id="task-admin-key" type="password" autocomplete="off" placeholder="TASKAPP_ADMIN_KEY" />
          </label>
          <button type="button" id="load-tasks-button" onclick="unlockTaskManager()">Load Tasks</button>
        </div>
      </div>
      ${taskConnections.length ? "" : `<div class="card"><p>No ClickUp connection is available. Connect ClickUp or configure the env fallback first.</p></div>`}
      <p id="task-feedback" class="task-feedback" role="status" aria-live="polite"></p>
      <div id="task-list" class="task-list" aria-live="polite"></div>
      <button type="button" id="load-more-tasks" class="secondary" hidden onclick="loadMoreTasks()">Load More</button>
    </section>

    <section class="${setupPanelClass(activeTab, "test")}" id="test">
      <div class="card">
        <h2>Test From Slack</h2>
        <p>Use this command in Slack after saving a runtime connection.</p>
        <pre>/taskapp Runtime test | assign: thomas | tags: oauth,demo | priority: high | due: tomorrow</pre>
      </div>
      <div class="card">
        <h2>Test Runtime Connection</h2>
        <p>Use the button on a connection card to create a test task with that saved runtime connection.</p>
      </div>
    </section>

    <section class="${setupPanelClass(activeTab, "demo-tools")}" id="demo-tools">
      <div class="card">
        <h2>Fallback Backend Test</h2>
        <p>This bypasses the Slack command flow and uses env fallback credentials. It is only for troubleshooting or debrief backup.</p>
        <form class="inline-form" method="POST" action="/api/run-demo" onsubmit="return confirm('This will create a real ClickUp task and post to Slack without going through /taskapp. Continue?');">
          <button type="submit">Run Backend Fallback Test</button>
        </form>
      </div>
      <div class="card danger-zone">
        <h2>Reset Runtime Connections</h2>
        <p>This clears only OAuth-created runtime connections. It does not affect env fallback settings.</p>
        <form class="inline-form" method="POST" action="/setup/reset" onsubmit="return confirm('Clear runtime connections? Env fallback will remain unchanged.');">
          <button type="submit">Clear Runtime Connections</button>
        </form>
      </div>
    </section>

    ${renderOAuthModal({
      id: "slack-modal",
      title: "Install Slack",
      body: "You will leave this page to authorize TaskApp in Slack. Slack will redirect back here after approval, and the app will store the Slack bot token as a runtime connection.",
      href: "/setup/slack/install",
      cta: "Continue to Slack"
    })}
    ${renderOAuthModal({
      id: "clickup-modal",
      title: "Connect ClickUp",
      body: "You will leave this page to authorize TaskApp in ClickUp. ClickUp will redirect back here after approval. After that, save the ClickUp List ID and aliases on the connection card.",
      href: "/setup/clickup/connect",
      cta: "Continue to ClickUp"
    })}
    <div class="modal-backdrop" id="task-edit-modal" role="dialog" aria-modal="true" aria-labelledby="task-edit-title">
      <div class="modal">
        <h2 id="task-edit-title">Edit ClickUp Task</h2>
        <form id="task-edit-form" onsubmit="saveTaskEdits(event)">
          <input type="hidden" id="edit-task-id" />
          <label>
            Title
            <input id="edit-task-name" required />
          </label>
          <label>
            Due date
            <input id="edit-task-due" type="date" />
          </label>
          <fieldset>
            <legend>Assignees</legend>
            <div id="edit-task-assignees"></div>
          </fieldset>
          <p class="modal-actions">
            <button type="submit">Save Changes</button>
            <button type="button" class="secondary" onclick="closeModal('task-edit-modal')">Cancel</button>
          </p>
        </form>
      </div>
    </div>
    <div class="modal-backdrop" id="task-delete-modal" role="dialog" aria-modal="true" aria-labelledby="task-delete-title">
      <div class="modal">
        <h2 id="task-delete-title">Delete ClickUp Task</h2>
        <p>Delete <strong id="delete-task-name"></strong> permanently?</p>
        <p class="error">This action cannot be undone.</p>
        <input type="hidden" id="delete-task-id" />
        <p class="modal-actions">
          <button type="button" class="danger-button" onclick="confirmTaskDelete()">Delete Task</button>
          <button type="button" class="secondary" onclick="closeModal('task-delete-modal')">Cancel</button>
        </p>
      </div>
    </div>
  `);
}

function renderStatusCard(label, value, detail) {
  const ok = Boolean(value);
  return `
    <div class="status-card">
      <span class="badge ${ok ? "ok" : "missing"}">${ok ? "Ready" : "Missing"}</span>
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(detail || (ok ? "Configured" : "Needs setup"))}</span>
    </div>
  `;
}

function normalizeSetupTab(tab) {
  const tabs = new Set(["workflow", "connections", "tasks", "test", "demo-tools"]);
  return tabs.has(tab) ? tab : "workflow";
}

function renderTaskConnectionOptions(connections) {
  if (!connections.length) return `<option value="">No ClickUp connections</option>`;
  return connections.map((connection) => {
    const ready = Boolean(connection.clickupToken && connection.clickupListId);
    const label = `${connection.name}${ready ? "" : " (needs ClickUp List)"}`;
    return `<option value="${escapeHtml(connection.id)}"${ready ? "" : " disabled"}>${escapeHtml(label)}</option>`;
  }).join("");
}

function setupTabClass(activeTab, tab) {
  return `tab${activeTab === tab ? " is-active" : ""}`;
}

function setupPanelClass(activeTab, tab) {
  return `tab-panel${activeTab === tab ? " is-active" : ""}`;
}

function renderConnectionForm(connection) {
  const channelOptions = renderSelectOptions(
    connection.slackChannels.map((channel) => ({
      value: channel.id,
      label: `#${channel.name}${channel.isMember ? "" : " (not joined)"}`
    })),
    connection.defaultSlackChannelId
  );
  const listOptions = renderSelectOptions(
    connection.clickupLists.map((list) => ({
      value: list.id,
      label: list.path
    })),
    connection.clickupListId
  );

  return `
  <div class="card">
    <form class="inline-form" method="POST" action="/setup/refresh-options">
      <input type="hidden" name="connectionId" value="${escapeHtml(connection.id)}" />
      <button type="submit">Refresh Options</button>
    </form>
    <form class="connection-settings-form" method="POST" action="/setup/connections">
      <input type="hidden" name="connectionId" value="${escapeHtml(connection.id)}" />
      <h3>${escapeHtml(connection.name)}</h3>
      <p class="muted">ID: <code>${escapeHtml(connection.id)}</code></p>
      <div class="status-grid connection-status-grid">
        ${renderStatusCard(
          "Slack Connection",
          connection.slackBotToken && connection.slackTeamId,
          connection.slackTeamName || connection.slackTeamId || "Install Slack"
        )}
        ${renderStatusCard(
          "ClickUp Connection",
          connection.clickupToken,
          connection.clickupListId ? `Connected to List ${connection.clickupListId}` : "Connected; choose a ClickUp List"
        )}
      </div>
      <p>Slack team: ${escapeHtml(connection.slackTeamName || connection.slackTeamId || "Not connected")}</p>
      <p>Slack bot token: ${statusText(connection.slackBotToken)}</p>
      <p>ClickUp token: ${statusText(connection.clickupToken)}</p>
      <p class="muted">Discovered Slack channels: ${connection.slackChannels.length}</p>
      <p class="muted">Discovered ClickUp lists: ${connection.clickupLists.length}</p>
      <p class="muted">Discovered ClickUp members: ${connection.clickupMembers.length}</p>
      <p><button type="button" onclick="openModal('clickup-${escapeHtml(connection.id)}')">Connect ClickUp for this connection</button></p>
      <label>
        Display name
        <input name="name" value="${escapeHtml(connection.name)}" />
      </label>
      <label>
        ClickUp List ID
        ${connection.clickupLists.length
          ? `<select name="clickupListId">${listOptions}</select>`
          : `<input name="clickupListId" value="${escapeHtml(connection.clickupListId || "")}" placeholder="901714346157" />`}
      </label>
      <label>
        Default Slack Channel ID
        ${connection.slackChannels.length
          ? `<select name="defaultSlackChannelId">${channelOptions}</select>`
          : `<input name="defaultSlackChannelId" value="${escapeHtml(connection.defaultSlackChannelId || "")}" placeholder="C1234567890" />`}
      </label>
      <label>
        Assignee aliases
        <input name="assigneeAliases" value="${escapeHtml(connection.assigneeAliases || "")}" placeholder="Thomas:32644579,Princess:32644580" />
      </label>
      ${connection.clickupMembers.length ? `
        <fieldset>
          <legend>Suggested assignee aliases</legend>
          <p class="muted">Selected aliases are merged with anything typed in the text field above.</p>
          ${connection.clickupMembers.map((member) => `
            <label class="checkbox-label">
              <input type="checkbox" name="selectedAssigneeAliases" value="${escapeHtml(member.alias)}" />
              ${escapeHtml(member.username)} -> <code>${escapeHtml(member.alias)}</code>
            </label>
          `).join("")}
        </fieldset>
      ` : ""}
      <p class="form-actions">
        <button type="submit">Save Connection</button>
        <span class="save-status" role="status" aria-live="polite"></span>
      </p>
    </form>
    ${renderOAuthModal({
      id: `clickup-${connection.id}`,
      title: "Connect ClickUp",
      body: `This will attach the ClickUp OAuth token to ${connection.name}.`,
      href: `/setup/clickup/connect?connectionId=${encodeURIComponent(connection.id)}`,
      cta: "Continue to ClickUp"
    })}
    <form class="inline-form" method="POST" action="/api/test-connection">
      <input type="hidden" name="connectionId" value="${escapeHtml(connection.id)}" />
    </form>
    <button type="button" onclick="testConnection('${escapeHtml(connection.id)}')">Test Runtime Connection</button>
  </div>
  `;
}

function renderSelectOptions(options, selectedValue) {
  const selected = String(selectedValue || "");
  const empty = `<option value="">Choose an option</option>`;
  return empty + options.map((option) => {
    const value = String(option.value);
    return `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(option.label)}</option>`;
  }).join("");
}

function renderOAuthModal({ id, title, body, href, cta }) {
  return `
    <div class="modal-backdrop" id="${escapeHtml(id)}" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(id)}-title">
      <div class="modal">
        <h2 id="${escapeHtml(id)}-title">${escapeHtml(title)}</h2>
        <p>${escapeHtml(body)}</p>
        <p class="modal-actions">
          <a class="button" href="${escapeHtml(href)}">${escapeHtml(cta)}</a>
          <button type="button" onclick="closeModal('${escapeHtml(id)}')">Cancel</button>
        </p>
      </div>
    </div>
  `;
}

function renderOAuthResult(provider, result) {
  return htmlPage(`${provider} Setup`, `
    <h1>${escapeHtml(provider)} Setup</h1>
    <p class="${result.ok ? "success" : "error"}">${escapeHtml(result.message || result.error)}</p>
    ${result.connection ? `<pre>${escapeHtml(JSON.stringify(result.connection, null, 2))}</pre>` : ""}
    <p><a href="/setup?tab=connections">Back to connections</a></p>
  `);
}

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { background: #f8fafc; color: #1f2937; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; margin: 0; padding: 32px; }
    main { max-width: 1040px; margin: 0 auto; }
    section, form { border: 0; margin: 0; padding: 0; }
    h1 { margin: 0; }
    h2 { margin-top: 0; }
    label { display: block; font-weight: 600; margin: 14px 0; }
    input, select { border: 1px solid #9ca3af; border-radius: 6px; box-sizing: border-box; display: block; font: inherit; margin-top: 6px; padding: 8px; width: 100%; }
    button, .button { background: #111827; border: 0; border-radius: 6px; color: white; display: inline-block; font: inherit; margin-right: 8px; padding: 9px 12px; text-decoration: none; }
    [hidden] { display: none !important; }
    button.secondary, .button.secondary { background: #e5e7eb; color: #111827; }
    summary { cursor: pointer; font-weight: 700; }
    fieldset { border: 1px solid #d1d5db; border-radius: 6px; margin: 16px 0; }
    legend { font-weight: 700; }
    code, pre { background: #f3f4f6; border-radius: 6px; padding: 2px 4px; }
    pre { overflow: auto; padding: 12px; }
    .page-header { align-items: center; display: flex; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
    .page-header p { color: #6b7280; margin: 4px 0 0; }
    .tabs { display: flex; gap: 6px; margin-bottom: 18px; overflow-x: auto; }
    .tab { background: #e5e7eb; color: #111827; }
    .tab.is-active { background: #111827; color: white; }
    .tab-panel { display: none; }
    .tab-panel.is-active { display: block; }
    .card, .status-card { background: white; border: 1px solid #d1d5db; border-radius: 8px; margin: 16px 0; padding: 18px; }
    .grid, .status-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .connection-status-grid { margin: 12px 0 18px; }
    .connection-status-grid .status-card { margin: 0; }
    .task-toolbar { align-items: end; display: flex; gap: 18px; justify-content: space-between; }
    .task-toolbar h2 { font-size: 26px; margin: 2px 0 0; }
    .task-toolbar-controls { align-items: end; display: grid; gap: 10px; grid-template-columns: minmax(190px, 1fr) minmax(190px, 1fr) auto; min-width: 560px; }
    .task-toolbar-controls label { margin: 0; }
    .task-feedback { min-height: 24px; }
    .task-feedback.is-success { color: #047857; font-weight: 700; }
    .task-feedback.is-error { color: #b91c1c; font-weight: 700; }
    .task-table-wrap { border: 1px solid #cbd5e1; border-radius: 8px; overflow-x: auto; }
    .task-table { background: white; border-collapse: collapse; min-width: 820px; width: 100%; }
    .task-table th, .task-table td { border-bottom: 1px solid #e2e8f0; padding: 12px; text-align: left; vertical-align: middle; }
    .task-table th { background: #f1f5f9; color: #475569; font-size: 12px; text-transform: uppercase; }
    .task-table tr:last-child td { border-bottom: 0; }
    .task-title { color: #0f172a; font-weight: 700; text-decoration: none; }
    .task-title:hover { text-decoration: underline; }
    .task-assignees { color: #475569; font-size: 14px; }
    .task-actions { white-space: nowrap; }
    .task-actions button { margin-bottom: 4px; }
    .task-empty { background: white; border: 1px solid #cbd5e1; border-radius: 8px; padding: 28px; text-align: center; }
    .danger-button { background: #b91c1c; }
    .workflow-heading { align-items: end; display: flex; gap: 16px; justify-content: space-between; margin: 6px 0 22px; }
    .workflow-heading h2 { font-size: 26px; margin: 2px 0 0; }
    .eyebrow, .detail-label { color: #475569; font-size: 12px; font-weight: 800; letter-spacing: 0; margin: 0; text-transform: uppercase; }
    .workflow-badge { background: #dcfce7; border: 1px solid #86efac; border-radius: 999px; color: #166534; font-size: 13px; font-weight: 700; padding: 6px 10px; white-space: nowrap; }
    .workflow-diagram { align-items: stretch; display: grid; grid-template-columns: minmax(0, 1fr) 72px minmax(0, 1fr) 72px minmax(0, 1fr) 72px minmax(0, 1fr); }
    .workflow-step { background: white; border: 1px solid #cbd5e1; border-radius: 8px; min-height: 190px; padding: 18px; position: relative; }
    .workflow-step strong, .workflow-step > span:last-child { display: block; }
    .workflow-step strong { font-size: 16px; margin: 18px 0 7px; }
    .workflow-step > span:last-child { color: #64748b; font-size: 14px; }
    .step-number { align-items: center; background: #0f172a; border-radius: 50%; color: white; display: flex; font-size: 12px; font-weight: 800; height: 26px; justify-content: center; position: absolute; right: 14px; top: 14px; width: 26px; }
    .step-app { border-radius: 5px; display: inline-block; font-size: 12px; font-weight: 800; padding: 5px 8px; }
    .slack-app { background: #f3e8ff; color: #6b21a8; }
    .taskapp-app { background: #dbeafe; color: #1e40af; }
    .clickup-app { background: #ffedd5; color: #9a3412; }
    .workflow-connector { align-items: center; display: flex; justify-content: center; position: relative; }
    .workflow-connector::before { background: #94a3b8; content: ""; height: 2px; left: 8px; position: absolute; right: 8px; top: 50%; }
    .workflow-connector::after { border-bottom: 5px solid transparent; border-left: 7px solid #64748b; border-top: 5px solid transparent; content: ""; position: absolute; right: 5px; top: calc(50% - 4px); }
    .workflow-connector span { background: #f8fafc; color: #64748b; font-size: 10px; font-weight: 700; padding: 3px; position: relative; text-align: center; z-index: 1; }
    .workflow-details { border-bottom: 1px solid #cbd5e1; border-top: 1px solid #cbd5e1; display: grid; gap: 0; grid-template-columns: repeat(3, 1fr); margin-top: 24px; }
    .workflow-details > div { padding: 18px; }
    .workflow-details > div + div { border-left: 1px solid #cbd5e1; }
    .workflow-details strong { display: block; margin-top: 5px; }
    .workflow-details p { color: #64748b; font-size: 14px; margin: 5px 0 0; }
    .status-card strong, .status-card span { display: block; }
    .status-card span:last-child { color: #6b7280; margin-top: 4px; }
    .badge { border-radius: 999px; display: inline-block; font-size: 12px; font-weight: 700; margin-bottom: 8px; padding: 3px 8px; }
    .badge.ok { background: #d1fae5; color: #065f46; }
    .badge.missing { background: #fee2e2; color: #991b1b; }
    .danger-zone { border-color: #fecaca; }
    .muted { color: #6b7280; }
    .success { color: #047857; font-weight: 700; }
    .error { color: #b91c1c; font-weight: 700; }
    .inline-form { border: 0; margin: 0; padding: 0; }
    .form-actions { align-items: center; display: flex; gap: 10px; margin-bottom: 0; }
    .save-status { color: #6b7280; font-weight: 700; }
    .save-status.is-success { color: #047857; }
    .save-status.is-error { color: #b91c1c; }
    .checkbox-label { align-items: center; display: flex; font-weight: 400; gap: 8px; margin: 8px 0; }
    .checkbox-label input { margin: 0; width: auto; }
    .modal-backdrop { align-items: center; background: rgba(17, 24, 39, 0.58); display: none; inset: 0; justify-content: center; padding: 20px; position: fixed; z-index: 10; }
    .modal-backdrop.is-open { display: flex; }
    .modal { background: white; border-radius: 8px; box-shadow: 0 24px 72px rgba(0, 0, 0, 0.25); max-width: 520px; padding: 22px; width: 100%; }
    .modal-actions { display: flex; gap: 8px; margin-bottom: 0; }
    @media (max-width: 900px) {
      .workflow-diagram { grid-template-columns: 1fr; }
      .workflow-step { min-height: 0; }
      .workflow-connector { height: 54px; }
      .workflow-connector::before { bottom: 8px; height: auto; left: 50%; right: auto; top: 8px; width: 2px; }
      .workflow-connector::after { border-left: 5px solid transparent; border-right: 5px solid transparent; border-top: 7px solid #64748b; bottom: 4px; left: calc(50% - 4px); right: auto; top: auto; }
      .workflow-connector span { max-width: 120px; }
      .task-toolbar { align-items: stretch; flex-direction: column; }
      .task-toolbar-controls { min-width: 0; }
    }
    @media (max-width: 640px) {
      body { padding: 20px; }
      .page-header, .workflow-heading { align-items: flex-start; flex-direction: column; }
      .workflow-badge { white-space: normal; }
      .workflow-details { grid-template-columns: 1fr; }
      .workflow-details > div + div { border-left: 0; border-top: 1px solid #cbd5e1; }
      .task-toolbar-controls { grid-template-columns: 1fr; }
    }
  </style>
  <script>
    function openModal(id) {
      document.getElementById(id)?.classList.add("is-open");
    }
    function closeModal(id) {
      document.getElementById(id)?.classList.remove("is-open");
    }
    document.addEventListener("click", function(event) {
      const tab = event.target.closest(".tab");
      if (!tab) return;
      const id = tab.getAttribute("data-tab");
      document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("is-active", item === tab));
      document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("is-active", panel.id === id));
      if (id === "tasks") prepareTaskManager();
    });
    document.addEventListener("submit", async function(event) {
      const form = event.target.closest(".connection-settings-form");
      if (!form) return;

      event.preventDefault();
      const status = form.querySelector(".save-status");
      const button = form.querySelector("button[type='submit']");
      status.textContent = "Saving...";
      status.className = "save-status";
      button.disabled = true;

      try {
        const response = await fetch(form.action, {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "fetch"
          },
          body: new URLSearchParams(new FormData(form))
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Save failed.");
        status.textContent = "✓ Saved";
        status.className = "save-status is-success";
      } catch (error) {
        status.textContent = error.message || "Save failed.";
        status.className = "save-status is-error";
      } finally {
        button.disabled = false;
      }
    });

    const taskState = {
      tasks: [],
      statuses: [],
      assignees: [],
      page: 0,
      hasMore: false
    };

    document.addEventListener("DOMContentLoaded", function() {
      const connection = document.getElementById("task-connection");
      if (connection) connection.addEventListener("change", function() {
        taskState.tasks = [];
        if (getTaskAdminKey()) loadTasks(0, false);
      });
      if (document.getElementById("tasks")?.classList.contains("is-active")) prepareTaskManager();
    });

    function prepareTaskManager() {
      const input = document.getElementById("task-admin-key");
      if (!input) return;
      const storedKey = sessionStorage.getItem("taskappAdminKey") || "";
      if (!input.value && storedKey) input.value = storedKey;
      if (storedKey && !taskState.tasks.length) loadTasks(0, false);
    }

    function getTaskAdminKey() {
      return document.getElementById("task-admin-key")?.value.trim() || "";
    }

    function unlockTaskManager() {
      const key = getTaskAdminKey();
      if (!key) {
        setTaskFeedback("Enter the task management admin key.", "error");
        document.getElementById("task-admin-key")?.focus();
        return;
      }
      sessionStorage.setItem("taskappAdminKey", key);
      loadTasks(0, false);
    }

    async function taskApi(path, options) {
      const key = getTaskAdminKey() || sessionStorage.getItem("taskappAdminKey") || "";
      const response = await fetch(path, {
        ...options,
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "X-TaskApp-Admin-Key": key,
          ...(options?.headers || {})
        }
      });
      const data = await response.json().catch(() => ({ ok: false, error: "Invalid server response." }));
      if (!response.ok || !data.ok) {
        if (response.status === 401) sessionStorage.removeItem("taskappAdminKey");
        throw new Error(data.error || "Task request failed.");
      }
      return data;
    }

    async function loadTasks(page, append) {
      const connectionId = document.getElementById("task-connection")?.value;
      if (!connectionId) {
        setTaskFeedback("Choose a configured ClickUp connection.", "error");
        return;
      }

      setTaskFeedback("Loading active tasks...");
      setTaskControlsDisabled(true);
      try {
        const data = await taskApi("/api/tasks?connectionId=" + encodeURIComponent(connectionId) + "&page=" + page, { method: "GET" });
        taskState.tasks = append ? taskState.tasks.concat(data.tasks) : data.tasks;
        taskState.statuses = data.statuses;
        taskState.assignees = data.assignees;
        taskState.page = data.page;
        taskState.hasMore = data.hasMore;
        renderTaskTable();
        setTaskFeedback(taskState.tasks.length + " active task" + (taskState.tasks.length === 1 ? "" : "s") + " loaded.", "success");
      } catch (error) {
        setTaskFeedback(error.message, "error");
      } finally {
        setTaskControlsDisabled(false);
      }
    }

    function loadMoreTasks() {
      loadTasks(taskState.page + 1, true);
    }

    function setTaskControlsDisabled(disabled) {
      const loadButton = document.getElementById("load-tasks-button");
      const moreButton = document.getElementById("load-more-tasks");
      if (loadButton) loadButton.disabled = disabled;
      if (moreButton) moreButton.disabled = disabled;
    }

    function setTaskFeedback(message, type) {
      const feedback = document.getElementById("task-feedback");
      if (!feedback) return;
      feedback.textContent = message || "";
      feedback.className = "task-feedback" + (type ? " is-" + type : "");
    }

    function renderTaskTable() {
      const container = document.getElementById("task-list");
      const loadMore = document.getElementById("load-more-tasks");
      if (!container || !loadMore) return;
      container.replaceChildren();
      loadMore.hidden = !taskState.hasMore;

      if (!taskState.tasks.length) {
        const empty = document.createElement("div");
        empty.className = "task-empty";
        empty.textContent = "No active tasks found in this ClickUp List.";
        container.appendChild(empty);
        return;
      }

      const wrap = document.createElement("div");
      wrap.className = "task-table-wrap";
      const table = document.createElement("table");
      table.className = "task-table";
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      ["Task", "Status", "Assignees", "Due date", "Actions"].forEach(function(label) {
        const cell = document.createElement("th");
        cell.textContent = label;
        headRow.appendChild(cell);
      });
      head.appendChild(headRow);
      table.appendChild(head);

      const body = document.createElement("tbody");
      taskState.tasks.forEach(function(task) {
        const row = document.createElement("tr");
        row.dataset.taskId = task.id;

        const titleCell = document.createElement("td");
        const title = document.createElement("a");
        title.className = "task-title";
        title.href = task.url;
        title.target = "_blank";
        title.rel = "noreferrer";
        title.textContent = task.name;
        titleCell.appendChild(title);

        const statusCell = document.createElement("td");
        const status = document.createElement("select");
        status.setAttribute("aria-label", "Status for " + task.name);
        taskState.statuses.forEach(function(item) {
          const option = document.createElement("option");
          option.value = item.name;
          option.textContent = item.name;
          option.selected = item.name.toLowerCase() === String(task.status || "").toLowerCase();
          status.appendChild(option);
        });
        status.addEventListener("change", function() { updateTaskStatus(task.id, status.value, status); });
        statusCell.appendChild(status);

        const assigneeCell = document.createElement("td");
        assigneeCell.className = "task-assignees";
        assigneeCell.textContent = task.assignees.length ? task.assignees.map(function(item) { return item.username; }).join(", ") : "Unassigned";

        const dueCell = document.createElement("td");
        dueCell.textContent = formatTaskDueDate(task.dueDate);

        const actionsCell = document.createElement("td");
        actionsCell.className = "task-actions";
        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "secondary";
        editButton.textContent = "Edit";
        editButton.addEventListener("click", function() { openTaskEdit(task.id); });
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "danger-button";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", function() { openTaskDelete(task.id); });
        actionsCell.append(editButton, deleteButton);

        row.append(titleCell, statusCell, assigneeCell, dueCell, actionsCell);
        body.appendChild(row);
      });
      table.appendChild(body);
      wrap.appendChild(table);
      container.appendChild(wrap);
    }

    function formatTaskDueDate(value) {
      if (!value) return "No due date";
      return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
    }

    function formatTaskDateInput(value) {
      if (!value) return "";
      const date = new Date(value);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return year + "-" + month + "-" + day;
    }

    function replaceManagedTask(updatedTask) {
      if (updatedTask.archived || updatedTask.statusType === "closed") {
        taskState.tasks = taskState.tasks.filter(function(task) { return task.id !== updatedTask.id; });
      } else {
        taskState.tasks = taskState.tasks.map(function(task) { return task.id === updatedTask.id ? updatedTask : task; });
      }
      renderTaskTable();
    }

    async function updateTaskStatus(taskId, status, select) {
      select.disabled = true;
      try {
        const data = await updateTaskRequest(taskId, { status: status });
        replaceManagedTask(data.task);
        setTaskFeedback("Task status updated to " + status + ".", "success");
      } catch (error) {
        setTaskFeedback(error.message, "error");
        renderTaskTable();
      }
    }

    function openTaskEdit(taskId) {
      const task = taskState.tasks.find(function(item) { return item.id === taskId; });
      if (!task) return;
      document.getElementById("edit-task-id").value = task.id;
      document.getElementById("edit-task-name").value = task.name;
      document.getElementById("edit-task-due").value = formatTaskDateInput(task.dueDate);
      const selectedIds = new Set(task.assignees.map(function(item) { return Number(item.id); }));
      const container = document.getElementById("edit-task-assignees");
      container.replaceChildren();
      if (!taskState.assignees.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "No ClickUp members are available for this List.";
        container.appendChild(empty);
      }
      taskState.assignees.forEach(function(member) {
        const label = document.createElement("label");
        label.className = "checkbox-label";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.name = "taskAssignee";
        checkbox.value = String(member.id);
        checkbox.checked = selectedIds.has(Number(member.id));
        label.append(checkbox, document.createTextNode(member.username));
        container.appendChild(label);
      });
      openModal("task-edit-modal");
    }

    async function saveTaskEdits(event) {
      event.preventDefault();
      const taskId = document.getElementById("edit-task-id").value;
      const assignees = Array.from(document.querySelectorAll("#edit-task-assignees input:checked")).map(function(input) { return input.value; });
      const submit = event.target.querySelector("button[type='submit']");
      submit.disabled = true;
      try {
        const data = await updateTaskRequest(taskId, {
          name: document.getElementById("edit-task-name").value,
          due: document.getElementById("edit-task-due").value || null,
          assignees: assignees
        });
        replaceManagedTask(data.task);
        closeModal("task-edit-modal");
        setTaskFeedback("Task properties updated.", "success");
      } catch (error) {
        setTaskFeedback(error.message, "error");
      } finally {
        submit.disabled = false;
      }
    }

    function updateTaskRequest(taskId, changes) {
      return taskApi("/api/tasks/" + encodeURIComponent(taskId), {
        method: "PATCH",
        body: JSON.stringify({
          connectionId: document.getElementById("task-connection").value,
          ...changes
        })
      });
    }

    function openTaskDelete(taskId) {
      const task = taskState.tasks.find(function(item) { return item.id === taskId; });
      if (!task) return;
      document.getElementById("delete-task-id").value = task.id;
      document.getElementById("delete-task-name").textContent = task.name;
      openModal("task-delete-modal");
    }

    async function confirmTaskDelete() {
      const taskId = document.getElementById("delete-task-id").value;
      const connectionId = document.getElementById("task-connection").value;
      try {
        const data = await taskApi("/api/tasks/" + encodeURIComponent(taskId) + "?connectionId=" + encodeURIComponent(connectionId), { method: "DELETE" });
        taskState.tasks = taskState.tasks.filter(function(task) { return task.id !== taskId; });
        renderTaskTable();
        closeModal("task-delete-modal");
        setTaskFeedback("Deleted " + (data.deletedTask.name || "task") + ".", "success");
      } catch (error) {
        setTaskFeedback(error.message, "error");
      }
    }

    async function testConnection(connectionId) {
      const response = await fetch("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: connectionId, tags: ["runtime", "test"] })
      });
      const data = await response.json();
      alert(data.ok ? "Runtime connection test created: " + data.clickupTask.url : "Runtime connection test failed: " + data.error);
    }
  </script>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

function statusText(value) {
  return value ? "Configured" : "Missing";
}

function parseSlackCommand(text) {
  const parts = text.split("|").map((part) => part.trim()).filter(Boolean);
  const result = { taskName: parts.shift() || "" };

  for (const part of parts) {
    const [rawKey, ...rawValue] = part.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.join(":").trim();

    if (key === "priority") result.priority = value;
    if (key === "due") result.due = value;
    if (key === "assign" || key === "assignee" || key === "assignees") result.assignees = value;
    if (key === "tags") result.tags = value;
    if (key === "description" || key === "desc") result.description = value;
  }

  return result;
}

function isHelpCommand(text) {
  const value = String(text || "").trim().toLowerCase();
  return ["help", "-h", "--help"].includes(value);
}

function isListCommand(text) {
  return String(text || "").trim().toLowerCase() === "list";
}

function buildUsageText(commandName) {
  return [
    `Usage: ${commandName} Task name | assign: jay | tags: bug,auth | priority: high | due: tomorrow | description: details`,
    `List active tasks: ${commandName} list`,
    "Assign: ClickUp user ID or alias configured in /setup",
    "Tags: comma-separated values",
    "Priorities: urgent, high, normal, low",
    "Due: today, tomorrow, or YYYY-MM-DD"
  ].join("\n");
}

function buildSlackTaskList(result) {
  if (!result.tasks.length) return "No active tasks found in the configured ClickUp List.";

  const maxLength = 35_000;
  const lines = [`Active ClickUp tasks (${result.tasks.length}):`];
  let omitted = 0;

  for (let index = 0; index < result.tasks.length; index += 1) {
    const task = result.tasks[index];
    const details = [
      task.status || "no status",
      task.dueDate ? `due ${formatSlackTaskDueDate(task.dueDate)}` : "no due date"
    ].join(" · ");
    const line = `${index + 1}. ${task.name} — ${details}\n${task.url}`;
    if ([...lines, line].join("\n").length > maxLength) {
      omitted = result.tasks.length - index;
      break;
    }
    lines.push(line);
  }

  if (omitted) lines.push(`…and ${omitted} more task${omitted === 1 ? "" : "s"}. Open ${APP_BASE_URL}/setup?tab=tasks to view them.`);
  if (result.truncatedByPageLimit) lines.push("Additional tasks may exist beyond the first 1,000 results.");
  return lines.join("\n");
}

function formatSlackTaskDueDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function buildSlackConfirmation(result) {
  return [
    `Created ClickUp task: ${result.clickupTask.name}`,
    result.clickupTask.url,
    result.requested.assignees.length ? `Assigned to: ${result.requested.assignees.join(", ")}` : null,
    result.requested.tags.length ? `Tags: ${result.requested.tags.join(", ")}` : null
  ].filter(Boolean).join("\n");
}

function resolveClickUpAssignees(input, aliasesText) {
  const values = normalizeList(input);
  if (!values.length) return { ok: true, ids: [], labels: [] };

  const aliases = parseAssigneeAliases(aliasesText);
  const ids = [];
  const labels = [];

  for (const value of values) {
    if (/^\d+$/.test(value)) {
      const id = Number(value);
      ids.push(id);
      labels.push(value);
      continue;
    }

    const alias = value.toLowerCase();
    if (!aliases[alias]) {
      return {
        ok: false,
        error: `Unknown assignee alias "${value}". Add it in /setup or use a ClickUp user ID.`
      };
    }

    ids.push(aliases[alias]);
    labels.push(value);
  }

  return {
    ok: true,
    ids: [...new Set(ids)],
    labels: [...new Set(labels)]
  };
}

function parseAssigneeAliases(aliasesText) {
  const aliases = {};
  for (const pair of normalizeList(aliasesText)) {
    const [rawName, rawId] = pair.split(":");
    const name = rawName?.trim().toLowerCase();
    const id = rawId?.trim();
    if (name && /^\d+$/.test(id)) aliases[name] = Number(id);
  }
  return aliases;
}

function mergeAliasText(...aliasGroups) {
  const aliases = new Map();
  for (const item of normalizeList(aliasGroups)) {
    const [rawName, rawId] = item.split(":");
    const name = rawName?.trim();
    const id = rawId?.trim();
    if (!name || !/^\d+$/.test(id)) continue;
    aliases.set(name.toLowerCase(), `${name}:${id}`);
  }
  return [...aliases.values()].join(",");
}

function makeAlias(name, id) {
  const alias = String(name || id)
    .split("@")[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${alias || id}:${id}`;
}

function normalizeTags(input) {
  return mergeTags(normalizeList(input));
}

function mergeTags(...tagGroups) {
  const tags = tagGroups.flatMap((group) => normalizeList(group));
  return [...new Set(tags.map((tag) => tag.toLowerCase()))];
}

function normalizeList(input) {
  if (!input) return [];
  const values = Array.isArray(input) ? input : String(input).split(",");
  return values
    .flatMap((value) => Array.isArray(value) ? value : String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizePriority(priority) {
  const value = String(priority || "normal").trim().toLowerCase();
  const priorities = {
    urgent: { value: 1, label: "urgent" },
    high: { value: 2, label: "high" },
    normal: { value: 3, label: "normal" },
    medium: { value: 3, label: "normal" },
    low: { value: 4, label: "low" }
  };

  if (["1", "2", "3", "4"].includes(value)) {
    const labels = { 1: "urgent", 2: "high", 3: "normal", 4: "low" };
    return { value: Number(value), label: labels[value] };
  }

  return priorities[value] || priorities.normal;
}

function parseTaskPage(value) {
  const page = value === null || value === "" ? 0 : Number(value);
  return Number.isInteger(page) && page >= 0 ? page : null;
}

function parseManagedDueDate(due) {
  const value = String(due || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "today" || value === "tomorrow") return parseDueDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}

function parseDueDate(due) {
  if (!due) return null;

  const value = String(due).trim().toLowerCase();
  const now = new Date();
  const date = new Date(now);

  if (value === "today") {
    date.setHours(23, 59, 59, 999);
    return date.getTime();
  }

  if (value === "tomorrow") {
    date.setDate(date.getDate() + 1);
    date.setHours(23, 59, 59, 999);
    return date.getTime();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getTime();
}

function verifySlackRequest(req, rawBody) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true;

  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) return false;

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (ageSeconds > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const digest = `v0=${crypto.createHmac("sha256", signingSecret).update(base).digest("hex")}`;

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

function verifyTaskAdminRequest(req) {
  const expected = process.env.TASKAPP_ADMIN_KEY;
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: "Task management is unavailable because TASKAPP_ADMIN_KEY is not configured."
    };
  }

  const provided = String(req.headers["x-taskapp-admin-key"] || "");
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length
    || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    return { ok: false, status: 401, error: "Invalid task management admin key." };
  }

  return { ok: true };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseJson(body) {
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function wantsJson(req) {
  return String(req.headers.accept || "").includes("application/json")
    || req.headers["x-requested-with"] === "fetch";
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
