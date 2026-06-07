# Slack to ClickUp Tasker

Lightweight FDE take-home app that connects Slack and ClickUp. A Slack slash command triggers this app, the app creates a ClickUp task, and Slack receives one clean confirmation with the task URL.

## What it does

- Accepts the Slack slash command `/taskapp` at `POST /slack/commands/clickup-task`.
- Verifies Slack requests with the Slack signing secret.
- Parses task details from the command text.
- Creates a task in a configured ClickUp List.
- Supports ClickUp assignees and custom tags.
- Returns one ephemeral Slack confirmation for slash-command requests.
- Exposes `POST /api/create-clickup-task` for direct testing; this endpoint creates a ClickUp task and posts a Slack message.
- Exposes `GET /health` and `GET /demo` for live inspection.

Example Slack command:

```text
/taskapp Review FDE submission | assign: jay | tags: demo,interview | priority: high | due: tomorrow | description: Final demo prep
```

## Requirements

- Node.js 18 or newer.
- A Slack app with:
  - Bot token with `chat:write`.
  - Slash command named `/taskapp`.
  - Request URL pointing to this app's `/slack/commands/clickup-task` endpoint.
  - Signing secret for request verification.
- A ClickUp personal token or OAuth access token.
- A ClickUp List ID.

## Local setup

Create a `.env` file:

```bash
cp .env.example .env
```

Fill in:

```bash
PORT=3000
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_DEFAULT_CHANNEL_ID=C1234567890
CLICKUP_TOKEN=pk_your-token
CLICKUP_LIST_ID=901714346157
CLICKUP_ASSIGNEE_ALIASES=jay:32644579,alex:12345678
```

`CLICKUP_ASSIGNEE_ALIASES` lets the Slack command use friendly names instead of raw ClickUp user IDs. You can also pass numeric ClickUp user IDs directly.

Start the server:

```bash
npm start
```

Check health:

```bash
curl http://localhost:3000/health
```

Inspect the demo metadata:

```bash
curl http://localhost:3000/demo
```

## Direct workflow test

This endpoint is useful before configuring the Slack slash command. It creates a ClickUp task and posts a message to Slack.

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

Expected result:

- A task is created in ClickUp.
- The task is assigned and tagged when `assignee`/`assignees` and `tags` are supplied.
- A message is posted to Slack.
- The API returns JSON with the ClickUp task ID, task URL, and Slack message timestamp.

## Slack slash command setup

In the Slack app configuration, create a slash command:

```text
/taskapp
```

Set the request URL to:

```text
https://YOUR_DEPLOYED_APP/slack/commands/clickup-task
```

Try this in Slack:

```text
/taskapp Review FDE submission | assign: jay | tags: demo,interview | priority: high | due: tomorrow
```

Help and validation examples:

```text
/taskapp help
/taskapp
```

Supported command fields:

```text
assign: ClickUp user ID or alias from CLICKUP_ASSIGNEE_ALIASES
assignee: same as assign
assignees: comma-separated aliases or ClickUp user IDs
tags: comma-separated ClickUp tags
priority: urgent, high, normal, low
due: today, tomorrow, or YYYY-MM-DD
description: task description
```

## Local tunnel testing

Cloudflare Tunnel works well for local Slack testing:

```bash
cloudflared tunnel --protocol http2 --url http://localhost:3000
```

Use the generated URL in Slack:

```text
https://YOUR_TRYCLOUDFLARE_URL/slack/commands/clickup-task
```

Then test:

```text
/taskapp Local tunnel test | assign: jay | tags: tunnel,demo | priority: high | due: tomorrow
```

## Render deployment

Deploy as a Render Web Service from the GitHub repo.

Render settings:

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
```

Set these environment variables in Render:

```text
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
SLACK_DEFAULT_CHANNEL_ID
CLICKUP_TOKEN
CLICKUP_LIST_ID
CLICKUP_ASSIGNEE_ALIASES
```

After deployment, update the Slack slash command Request URL to:

```text
https://YOUR_RENDER_APP.onrender.com/slack/commands/clickup-task
```

Public inspection endpoints:

```text
https://YOUR_RENDER_APP.onrender.com/health
https://YOUR_RENDER_APP.onrender.com/demo
```

If using Render's free tier, open `/health` shortly before the live demo to wake the service.

## Demo script

Short explanation:

```text
This app connects Slack and ClickUp. Slack sends a signed slash-command webhook to my Node server. The server verifies the request, parses the task details, creates a task in ClickUp through the ClickUp API, and returns one ephemeral Slack confirmation with the task URL. I also included a direct API endpoint plus health and demo endpoints for live inspection.
```

Live demo command:

```text
/taskapp Render demo task | assign: jay | tags: render,demo | priority: high | due: tomorrow | description: Created during the FDE debrief
```

## Screenshots

Add final screenshots in `screenshots/` before submission:

- Slack command success response.
- ClickUp task created.
- `/health` or `/demo` response.

## Error handling

The app gracefully handles:

- Missing task name.
- Missing ClickUp token or list ID.
- Missing Slack bot token.
- Unknown ClickUp assignee alias.
- ClickUp API errors.
- Slack API errors.
- Invalid Slack request signatures when `SLACK_SIGNING_SECRET` is configured.

## Security notes

- `.env` is ignored by Git and should never be committed.
- `.env.example` is safe to commit because it contains placeholders only.
- Rotate Slack and ClickUp tokens before final deployment or public submission if they were shared during testing.

## Assumptions

- This demo uses environment variables for Slack and ClickUp credentials.
- The Slack command name is `/taskapp`.
- Assignee aliases are configured through `CLICKUP_ASSIGNEE_ALIASES`.
- The ClickUp List ID is configured once for the demo.
- A production multi-tenant version would store Slack workspace IDs and ClickUp workspace/list selections per connection.
