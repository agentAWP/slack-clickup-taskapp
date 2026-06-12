# Slack to ClickUp Tasker

Lightweight FDE take-home app that connects Slack and ClickUp. A Slack slash command triggers this app, the app creates a ClickUp task, and Slack receives one clean confirmation with the task URL.

Live deployment:

- App and setup: https://slack-clickup-taskapp.onrender.com/setup
- Health: https://slack-clickup-taskapp.onrender.com/health
- Demo metadata: https://slack-clickup-taskapp.onrender.com/demo

## What it does

- Accepts the Slack slash command `/taskapp` at `POST /slack/commands/clickup-task`.
- Supports `/taskapp list` to return active tasks from the connected ClickUp List.
- Verifies Slack requests with the Slack signing secret.
- Lets integrations be connected/configured at runtime through `GET /setup`.
- Shows modal-style confirmations before redirecting to Slack or ClickUp OAuth.
- Stores runtime connection settings in `data/connections.json`.
- Creates ClickUp tasks with priority, due date, assignees, and tags.
- Returns one ephemeral Slack confirmation for slash-command requests.
- Provides `POST /api/run-demo` as a stable env-backed fallback demo path.
- Provides `POST /api/test-connection` for testing a runtime connection.
- Exposes `POST /api/create-clickup-task` for direct testing; this endpoint creates a ClickUp task and posts a Slack message.
- Exposes protected task-management endpoints under `/api/tasks`.
- Exposes `GET /health` and `GET /demo` for live inspection.

Example Slack command:

```text
/taskapp Review FDE submission | assign: jay | tags: demo,interview | priority: high | due: tomorrow | description: Final demo prep
```

## Requirements

- Node.js 18 or newer.
- A Slack app with:
  - Bot token with `chat:write`.
  - Channel discovery scopes `channels:read` and `channels:join`.
  - Slash command named `/taskapp`.
  - Request URL pointing to this app's `/slack/commands/clickup-task` endpoint.
  - Signing secret for request verification.
  - OAuth redirect URL pointing to `/oauth/slack/callback`.
- A ClickUp OAuth app with redirect URL pointing to `/oauth/clickup/callback`.

## Local setup

Create a `.env` file:

```bash
cp .env.example .env
```

Fill in app-level values:

```bash
PORT=3000
APP_BASE_URL=http://localhost:3000
DATA_FILE=data/connections.json
TASKAPP_ADMIN_KEY=choose-a-long-random-admin-key
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_CLIENT_ID=your-slack-client-id
SLACK_CLIENT_SECRET=your-slack-client-secret
CLICKUP_CLIENT_ID=your-clickup-client-id
CLICKUP_CLIENT_SECRET=your-clickup-client-secret
```

Optional local fallback values still work for quick testing without OAuth:

```bash
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_DEFAULT_CHANNEL_ID=C1234567890
CLICKUP_TOKEN=pk_your-token
CLICKUP_LIST_ID=901714346157
CLICKUP_ASSIGNEE_ALIASES=jay:32644579,alex:12345678
```

Start the server:

```bash
npm start
```

Check health:

```bash
curl http://localhost:3000/health
```

Open setup:

```text
http://localhost:3000/setup
```

Inspect demo metadata:

```bash
curl http://localhost:3000/demo
```

## Runtime connection setup

The setup page lets you connect/configure integrations without editing code or redeploying for each new connection.

Slack redirect URL:

```text
http://localhost:3000/oauth/slack/callback
```

ClickUp redirect URL:

```text
http://localhost:3000/oauth/clickup/callback
```

For deployed Render:

```text
https://slack-clickup-taskapp.onrender.com/oauth/slack/callback
https://slack-clickup-taskapp.onrender.com/oauth/clickup/callback
```

Setup flow:

1. Open `/setup`.
2. Click **Install Slack**, confirm the modal, and authorize Slack.
3. Click **Connect ClickUp**, confirm the modal, and authorize ClickUp.
4. Click **Refresh Options** to discover Slack channels, ClickUp Lists, and ClickUp List members.
5. Select a ClickUp List, select a default Slack channel, choose suggested member aliases or type your own aliases, then save.
6. Use `/taskapp` in Slack.

Assignee aliases use this format:

```text
Thomas:32644579,Princess:32644580
```

The setup page also includes:

- **Refresh Options**: populates Slack channel dropdowns, ClickUp List dropdowns, and assignee alias suggestions.
- **Run Demo**: uses the env fallback connection to create a known-good demo task.
- **Test Runtime Connection**: creates a test task through the selected runtime connection.
- **Clear Runtime Connections**: clears OAuth-created runtime connections without changing env fallback settings.

## Task management

The protected task-management API handles non-archived tasks whose status is not closed. Task data remains authoritative in ClickUp and does not depend on Render filesystem persistence.

Set a long random value locally and in Render:

```text
TASKAPP_ADMIN_KEY=your-long-random-value
```

The task-management UI is intentionally hidden from the public setup page. The JSON endpoints require this value in the `X-TaskApp-Admin-Key` header.

List active tasks:

```bash
curl --request GET \
  --url "https://slack-clickup-taskapp.onrender.com/api/tasks?connectionId=env-fallback&page=0" \
  --header "X-TaskApp-Admin-Key: YOUR_ADMIN_KEY"
```

Update title, due date, final assignee selection, or status:

```bash
curl --request PATCH \
  --url "https://slack-clickup-taskapp.onrender.com/api/tasks/TASK_ID" \
  --header "Content-Type: application/json" \
  --header "X-TaskApp-Admin-Key: YOUR_ADMIN_KEY" \
  --data '{
    "connectionId": "env-fallback",
    "name": "Updated task title",
    "due": "2026-06-15",
    "assignees": [32644579],
    "status": "in progress"
  }'
```

The `assignees` array is the desired final selection. TaskApp compares it with the current task and sends ClickUp the necessary additions and removals. Use an empty array to make the task unassigned.

Permanently delete a task:

```bash
curl --request DELETE \
  --url "https://slack-clickup-taskapp.onrender.com/api/tasks/TASK_ID?connectionId=env-fallback" \
  --header "X-TaskApp-Admin-Key: YOUR_ADMIN_KEY"
```

Deletion is permanent. API clients should require explicit confirmation before sending the request.

## Direct workflow test

This endpoint is useful before configuring the Slack slash command. It creates a ClickUp task and posts a message to Slack. It uses a runtime connection when available, otherwise the optional env fallback.

```bash
curl --request POST \
  --url "http://localhost:3000/api/create-clickup-task" \
  --header "Content-Type: application/json" \
  --data '{
    "name": "Test task from local app",
    "description": "Created by the direct workflow endpoint",
    "priority": "high",
    "due": "tomorrow",
    "assignee": "jay",
    "tags": ["demo", "api"],
    "channel": "YOUR_SLACK_CHANNEL_ID"
  }'
```

With a specific runtime connection:

```json
{
  "connectionId": "runtime-connection-id",
  "name": "Direct API test task"
}
```

Expected result:

- A task is created in ClickUp.
- The task is assigned and tagged when `assignee`/`assignees` and `tags` are supplied.
- A message is posted to Slack.
- The API returns JSON with the connection used, ClickUp task ID, task URL, and Slack message timestamp.

## Slack slash command setup

In the Slack app configuration, create a slash command:

```text
/taskapp
```

Set the request URL to:

```text
https://slack-clickup-taskapp.onrender.com/slack/commands/clickup-task
```

Try this in Slack:

```text
/taskapp Review FDE submission | assign: jay | tags: demo,interview | priority: high | due: tomorrow
```

List active tasks from the configured ClickUp List:

```text
/taskapp list
```

The list response is ephemeral and includes each task's title, status, due date, and ClickUp URL. Closed and archived tasks are excluded.

Help and validation examples:

```text
/taskapp help
/taskapp
/taskapp list
```

Supported command fields:

```text
assign: ClickUp user ID or alias configured in /setup
assignee: same as assign
assignees: comma-separated aliases or ClickUp user IDs
tags: comma-separated ClickUp tags
priority: urgent, high, normal, low
due: today, tomorrow, or YYYY-MM-DD
description: task description
```

## Local tunnel testing

Cloudflare Tunnel is only needed if Slack or OAuth providers must call your local machine.

```bash
cloudflared tunnel --protocol http2 --url http://localhost:3000
```

Use the generated URL for:

```text
SLACK Request URL: https://YOUR_TRYCLOUDFLARE_URL/slack/commands/clickup-task
Slack OAuth redirect: https://YOUR_TRYCLOUDFLARE_URL/oauth/slack/callback
ClickUp OAuth redirect: https://YOUR_TRYCLOUDFLARE_URL/oauth/clickup/callback
APP_BASE_URL=https://YOUR_TRYCLOUDFLARE_URL
```

## Render deployment

Deploy as a Render Web Service from the GitHub repo.

Render settings:

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
```

Set these app-level environment variables in Render:

```text
APP_BASE_URL
DATA_FILE
SLACK_CLIENT_ID
SLACK_CLIENT_SECRET
SLACK_SIGNING_SECRET
CLICKUP_CLIENT_ID
CLICKUP_CLIENT_SECRET
TASKAPP_ADMIN_KEY
```

Optional fallback env vars:

```text
SLACK_BOT_TOKEN
SLACK_DEFAULT_CHANNEL_ID
CLICKUP_TOKEN
CLICKUP_LIST_ID
CLICKUP_ASSIGNEE_ALIASES
```

After deployment, update the Slack slash command Request URL to:

```text
https://slack-clickup-taskapp.onrender.com/slack/commands/clickup-task
```

Public inspection endpoints:

```text
https://slack-clickup-taskapp.onrender.com/setup
https://slack-clickup-taskapp.onrender.com/health
https://slack-clickup-taskapp.onrender.com/demo
```

Fallback demo endpoint:

```bash
curl --request POST https://slack-clickup-taskapp.onrender.com/api/run-demo
```

Runtime connection test endpoint:

```bash
curl --request POST \
  --url "https://slack-clickup-taskapp.onrender.com/api/test-connection" \
  --header "Content-Type: application/json" \
  --data '{"connectionId":"runtime-connection-id","tags":["runtime","test"]}'
```

This project uses Render's free tier. Open `/health` shortly before the live demo because a sleeping instance may take about a minute to wake.

### Runtime storage decision

Runtime OAuth connections are stored in `data/connections.json`. Render's free tier does not provide a persistent disk, so this file is intentionally treated as ephemeral and may be cleared by a restart or deployment.

For this take-home:

- The in-product OAuth flow demonstrates that Slack and ClickUp connections can be created dynamically without changing code or redeploying.
- Environment-backed Slack and ClickUp credentials provide a reliable fallback for the interview demo.
- Reconnecting through `/setup` restores a runtime connection if Render clears the file.
- A production deployment would store encrypted OAuth tokens and connection metadata in a database or managed secret store.

## Demo script

Short explanation:

```text
This app connects Slack and ClickUp. Slack sends a signed slash-command webhook to my Node server. The server verifies the request, resolves the connected Slack team to a runtime ClickUp connection, parses the task details, creates a task in ClickUp, and returns one ephemeral Slack confirmation with the task URL. I also included a setup page, direct API endpoint, health endpoint, and demo endpoint for live inspection.
```

Fallback line if the ephemeral runtime connection is unavailable during the debrief:

```text
I also kept an env-configured backend fallback, so the core Slack/ClickUp workflow can still be demonstrated reliably while the live OAuth setup remains visible in-product.
```

Live demo command:

```text
/taskapp Render demo task | assign: jay | tags: render,demo | priority: high | due: tomorrow | description: Created during the FDE debrief
```

## Error handling

The app gracefully handles:

- Missing task name.
- Missing runtime connection.
- Missing ClickUp token or list ID for a connection.
- Missing Slack bot token for a connection.
- Unknown ClickUp assignee alias.
- Invalid or missing task-management admin key.
- Invalid task status or due date.
- Attempts to update or delete a task outside the configured ClickUp List.
- ClickUp rate limits, including retry guidance when available.
- ClickUp API errors.
- Slack API errors.
- Invalid Slack request signatures when `SLACK_SIGNING_SECRET` is configured.

## Security notes

- `.env` is ignored by Git and should never be committed.
- `data/` is ignored by Git because it can contain runtime tokens.
- `.env.example` is safe to commit because it contains placeholders only.
- App-level OAuth client secrets stay in environment variables.
- Task-management endpoints require `TASKAPP_ADMIN_KEY`.
- Runtime integration tokens are stored in the connection store for this take-home. A production version should use encrypted storage.

## Assumptions

- This demo uses a lightweight JSON file instead of a database.
- Render free-tier runtime connection storage is ephemeral by design; env-backed credentials are the demo fallback.
- The Slack command name is `/taskapp`.
- Runtime setup is intentionally simple server-rendered HTML.
- A production multi-tenant version would add auth around `/setup`, encrypted token storage, and a database-backed connection table.
