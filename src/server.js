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
      return sendHtml(res, result.ok ? 200 : 400, renderOAuthResult("Slack", result));
    }

    if (req.method === "GET" && url.pathname === "/setup/clickup/connect") {
      return redirect(res, buildClickUpInstallUrl(url.searchParams.get("connectionId")));
    }

    if (req.method === "GET" && url.pathname === "/oauth/clickup/callback") {
      const result = await handleClickUpOAuthCallback(url);
      return sendHtml(res, result.ok ? 200 : 400, renderOAuthResult("ClickUp", result));
    }

    if (req.method === "POST" && url.pathname === "/setup/connections") {
      const rawBody = await readBody(req);
      const form = new URLSearchParams(rawBody);
      const result = saveConnectionSettings({
        connectionId: form.get("connectionId"),
        name: form.get("name"),
        clickupListId: form.get("clickupListId"),
        assigneeAliases: form.get("assigneeAliases"),
        defaultSlackChannelId: form.get("defaultSlackChannelId")
      });

      if (!result.ok) {
        return sendHtml(res, 400, renderOAuthResult("Connection settings", result));
      }

      return redirect(res, "/setup?saved=1");
    }

    if (req.method === "POST" && url.pathname === "/setup/reset") {
      saveConnectionStore({ connections: [] });
      return redirect(res, "/setup?reset=1");
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
    defaultSlackChannelId: process.env.SLACK_DEFAULT_CHANNEL_ID || null
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

function buildSlackInstallUrl() {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) return "/setup?error=missing_slack_client_id";
  const authorizeUrl = new URL("https://slack.com/oauth/v2/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("scope", "commands,chat:write");
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

  return htmlPage("TaskApp Setup", `
    <h1>TaskApp Setup</h1>
    <p>Connect Slack and ClickUp, then configure the ClickUp List and assignee aliases without editing code or redeploying.</p>
    ${error ? `<p class="error">Setup error: ${escapeHtml(error)}</p>` : ""}
    ${saved ? `<p class="success">Connection settings saved.</p>` : ""}
    ${reset ? `<p class="success">Runtime connections cleared.</p>` : ""}

    <section>
      <h2>OAuth App Status</h2>
      <ul>
        <li>Slack OAuth app: ${statusText(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET)}</li>
        <li>Slack signing secret: ${statusText(process.env.SLACK_SIGNING_SECRET)}</li>
        <li>ClickUp OAuth app: ${statusText(process.env.CLICKUP_CLIENT_ID && process.env.CLICKUP_CLIENT_SECRET)}</li>
        <li>Runtime connections: ${connections.length}</li>
        <li>Environment fallback: ${statusText(fallback)}</li>
      </ul>
    </section>

    <section>
      <h2>Connect Integrations</h2>
      <p>
        <button type="button" onclick="openModal('slack-modal')">Install Slack</button>
        <button type="button" onclick="openModal('clickup-modal')">Connect ClickUp</button>
      </p>
      <p class="muted">Slack redirect URL: <code>${APP_BASE_URL}/oauth/slack/callback</code></p>
      <p class="muted">ClickUp redirect URL: <code>${APP_BASE_URL}/oauth/clickup/callback</code></p>
    </section>

    <section>
      <h2>Reliable Demo Fallback</h2>
      <p>Use the existing env-configured Slack and ClickUp connection as a safe demo path if live OAuth setup is unavailable.</p>
      <form class="inline-form" method="POST" action="/api/run-demo">
        <button type="submit">Run Demo</button>
      </form>
    </section>

    <section>
      <h2>Runtime Connections</h2>
      ${connections.length ? connections.map(renderConnectionForm).join("") : "<p>No runtime connections yet. Install Slack and connect ClickUp to create one.</p>"}
    </section>

    <section>
      <h2>Reset Runtime Connections</h2>
      <p>This clears only OAuth-created runtime connections. It does not affect env fallback settings.</p>
      <form class="inline-form" method="POST" action="/setup/reset" onsubmit="return confirm('Clear runtime connections? Env fallback will remain unchanged.');">
        <button type="submit">Clear Runtime Connections</button>
      </form>
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

function renderConnectionForm(connection) {
  return `
    <form method="POST" action="/setup/connections">
      <input type="hidden" name="connectionId" value="${escapeHtml(connection.id)}" />
      <h3>${escapeHtml(connection.name)}</h3>
      <p class="muted">ID: <code>${escapeHtml(connection.id)}</code></p>
      <p>Slack team: ${escapeHtml(connection.slackTeamName || connection.slackTeamId || "Not connected")}</p>
      <p>Slack bot token: ${statusText(connection.slackBotToken)}</p>
      <p>ClickUp token: ${statusText(connection.clickupToken)}</p>
      <p><button type="button" onclick="openModal('clickup-${escapeHtml(connection.id)}')">Connect ClickUp for this connection</button></p>
      <label>
        Display name
        <input name="name" value="${escapeHtml(connection.name)}" />
      </label>
      <label>
        ClickUp List ID
        <input name="clickupListId" value="${escapeHtml(connection.clickupListId || "")}" placeholder="901714346157" />
      </label>
      <label>
        Default Slack Channel ID
        <input name="defaultSlackChannelId" value="${escapeHtml(connection.defaultSlackChannelId || "")}" placeholder="C1234567890" />
      </label>
      <label>
        Assignee aliases
        <input name="assigneeAliases" value="${escapeHtml(connection.assigneeAliases || "")}" placeholder="Thomas:32644579,Princess:32644580" />
      </label>
      <button type="submit">Save Connection</button>
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
  `;
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
    <p><a href="/setup">Back to setup</a></p>
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
    body { color: #1f2937; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; margin: 0; padding: 32px; }
    main { max-width: 920px; margin: 0 auto; }
    section, form { border: 1px solid #d1d5db; border-radius: 8px; margin: 20px 0; padding: 18px; }
    label { display: block; font-weight: 600; margin: 14px 0; }
    input { border: 1px solid #9ca3af; border-radius: 6px; box-sizing: border-box; display: block; font: inherit; margin-top: 6px; padding: 8px; width: 100%; }
    button, .button { background: #111827; border: 0; border-radius: 6px; color: white; display: inline-block; font: inherit; margin-right: 8px; padding: 9px 12px; text-decoration: none; }
    code, pre { background: #f3f4f6; border-radius: 6px; padding: 2px 4px; }
    pre { overflow: auto; padding: 12px; }
    .muted { color: #6b7280; }
    .success { color: #047857; font-weight: 700; }
    .error { color: #b91c1c; font-weight: 700; }
    .inline-form { border: 0; margin: 0; padding: 0; }
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
