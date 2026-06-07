const crypto = require("crypto");
const http = require("http");
const { URL } = require("url");

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
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
          "GET /health",
          "GET /demo",
          "POST /api/create-clickup-task",
          "POST /slack/commands/clickup-task"
        ]
      });
    }

    if (req.method === "GET" && url.pathname === "/demo") {
      return sendJson(res, 200, {
        ok: true,
        app: "Slack to ClickUp Tasker",
        purpose: "Create ClickUp tasks from a Slack slash command.",
        sampleCommand: "/taskapp Review FDE submission | priority: high | due: tomorrow",
        workflow: [
          "Slack sends a signed slash-command webhook to this app.",
          "The app verifies the Slack request signature.",
          "The app parses task name, priority, due date, and description from the command text.",
          "The app creates a task in the configured ClickUp List.",
          "The app returns one ephemeral Slack confirmation with the ClickUp task URL."
        ],
        endpoints: {
          health: "GET /health",
          demo: "GET /demo",
          directWorkflowTest: "POST /api/create-clickup-task",
          slackSlashCommand: "POST /slack/commands/clickup-task"
        },
        commandSyntax: {
          command: "/taskapp",
          format: "/taskapp Task name | priority: high | due: tomorrow | description: details",
          priorities: ["urgent", "high", "normal", "low"],
          dueDateExamples: ["today", "tomorrow", "2026-06-10"]
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        clickupConfigured: Boolean(process.env.CLICKUP_TOKEN && process.env.CLICKUP_LIST_ID),
        slackConfigured: Boolean(process.env.SLACK_BOT_TOKEN),
        slackSigningConfigured: Boolean(process.env.SLACK_SIGNING_SECRET)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/create-clickup-task") {
      const body = await readBody(req);
      const payload = parseJson(body);
      const result = await runTaskWorkflow({
        taskName: payload.name,
        description: payload.description,
        priority: payload.priority,
        due: payload.due,
        slackChannelId: payload.channel || process.env.SLACK_DEFAULT_CHANNEL_ID,
        source: "api"
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

      const result = await runTaskWorkflow({
        taskName: parsed.taskName,
        description: parsed.description || `Created from Slack by ${form.get("user_name") || form.get("user_id") || "unknown user"}.`,
        priority: parsed.priority,
        due: parsed.due,
        slackChannelId: form.get("channel_id"),
        source: "slack_command",
        slackUserId: form.get("user_id"),
        postSlackConfirmation: false
      });

      return sendJson(res, 200, {
        response_type: "ephemeral",
        text: result.ok
          ? `Created ClickUp task: ${result.clickupTask.name}\n${result.clickupTask.url}`
          : `Could not create ClickUp task: ${result.error}`,
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
    return { ok: false, error: validationError };
  }

  try {
    const clickupTask = await createClickUpTask(input);
    const slackMessage = input.postSlackConfirmation === false
      ? { skipped: true, reason: "Slash command response is used as the Slack confirmation." }
      : await postSlackMessage({
        channel: input.slackChannelId,
        text: [
          `ClickUp task created: ${clickupTask.name}`,
          clickupTask.url,
          `Priority: ${normalizePriority(input.priority).label}`
        ].filter(Boolean).join("\n")
      });

    return {
      ok: true,
      source: input.source,
      requested: {
        taskName: input.taskName,
        priority: normalizePriority(input.priority).label,
        due: input.due || null,
        slackChannelId: input.slackChannelId || null
      },
      clickupTask,
      slackMessage
    };
  } catch (error) {
    return {
      ok: false,
      source: input.source,
      error: error.message
    };
  }
}

function validateWorkflowInput(input) {
  if (!process.env.CLICKUP_TOKEN) return "Missing CLICKUP_TOKEN.";
  if (!process.env.CLICKUP_LIST_ID) return "Missing CLICKUP_LIST_ID.";
  if (!process.env.SLACK_BOT_TOKEN) return "Missing SLACK_BOT_TOKEN.";
  if (!input.taskName || !input.taskName.trim()) return "Missing task name.";
  return null;
}

async function createClickUpTask(input) {
  const priority = normalizePriority(input.priority);
  const body = {
    name: input.taskName.trim(),
    description: input.description || "Created by the Slack to ClickUp integration.",
    priority: priority.value,
    tags: ["slack"]
  };

  const dueDate = parseDueDate(input.due);
  if (dueDate) body.due_date = dueDate;

  const response = await fetch(`${CLICKUP_API_BASE}/list/${process.env.CLICKUP_LIST_ID}/task`, {
    method: "POST",
    headers: {
      Authorization: process.env.CLICKUP_TOKEN,
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
    status: data.status?.status || null,
    url: data.url || null
  };
}

async function postSlackMessage({ channel, text }) {
  if (!channel) {
    return { skipped: true, reason: "No Slack channel provided." };
  }

  const response = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
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

function parseSlackCommand(text) {
  const parts = text.split("|").map((part) => part.trim()).filter(Boolean);
  const result = { taskName: parts.shift() || "" };

  for (const part of parts) {
    const [rawKey, ...rawValue] = part.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.join(":").trim();

    if (key === "priority") result.priority = value;
    if (key === "due") result.due = value;
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
    `Usage: ${commandName} Task name | priority: high | due: tomorrow | description: details`,
    "Priorities: urgent, high, normal, low",
    "Due: today, tomorrow, or YYYY-MM-DD"
  ].join("\n");
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

function loadDotEnv() {
  const fs = require("fs");
  const path = require("path");
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
