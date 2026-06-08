const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const DATA_FILE = process.env.DATA_FILE || path.join(process.cwd(), "data", "connections.json");
const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";
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
          slackSlashCommand: "POST /slack/commands/clickup-task"
        },
        commandSyntax: {
          command: "/taskapp",
          format: "/taskapp Task name | assign: jay | tags: bug,auth | priority: high | due: tomorrow | description: details",
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
        }
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
    return connections.find((connection) => connection.id === connectionId) || null;
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
      <button type="button" class="${setupTabClass(activeTab, "test")}" data-tab="test">Test</button>
      <button type="button" class="${setupTabClass(activeTab, "demo-tools")}" data-tab="demo-tools">Demo Tools</button>
    </nav>

    <section class="${setupPanelClass(activeTab, "workflow")}" id="workflow">
      <div class="workflow-map">
        <div class="node">
          <strong>Slack</strong>
          <span>/taskapp command</span>
        </div>
        <div class="arrow">→</div>
        <div class="node">
          <strong>TaskApp</strong>
          <span>parse + map fields</span>
        </div>
        <div class="arrow">→</div>
        <div class="node">
          <strong>ClickUp</strong>
          <span>create task</span>
        </div>
      </div>
      <div class="grid">
        <div class="card">
          <h2>Trigger</h2>
          <p>Slack sends a signed slash-command webhook to this app.</p>
        </div>
        <div class="card">
          <h2>Mapped Fields</h2>
          <p>Name, assignee, tags, priority, due date, and description.</p>
        </div>
        <div class="card">
          <h2>Action</h2>
          <p>Create a ClickUp task in the selected List and return a Slack confirmation.</p>
        </div>
      </div>
    </section>

    <section class="${setupPanelClass(activeTab, "connections")}" id="connections">
      <div class="status-grid">
        ${renderStatusCard("Slack OAuth App", process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET)}
        ${renderStatusCard("Slack Signing", process.env.SLACK_SIGNING_SECRET)}
        ${renderStatusCard("ClickUp OAuth App", process.env.CLICKUP_CLIENT_ID && process.env.CLICKUP_CLIENT_SECRET)}
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
  const tabs = new Set(["workflow", "connections", "test", "demo-tools"]);
  return tabs.has(tab) ? tab : "workflow";
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
    .workflow-map { align-items: stretch; display: grid; gap: 12px; grid-template-columns: 1fr auto 1fr auto 1fr; margin-bottom: 18px; }
    .node { background: white; border: 1px solid #d1d5db; border-radius: 8px; padding: 16px; }
    .node strong, .node span { display: block; }
    .node span { color: #6b7280; margin-top: 4px; }
    .arrow { align-self: center; color: #6b7280; font-size: 24px; }
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

function buildUsageText(commandName) {
  return [
    `Usage: ${commandName} Task name | assign: jay | tags: bug,auth | priority: high | due: tomorrow | description: details`,
    "Assign: ClickUp user ID or alias configured in /setup",
    "Tags: comma-separated values",
    "Priorities: urgent, high, normal, low",
    "Due: today, tomorrow, or YYYY-MM-DD"
  ].join("\n");
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
