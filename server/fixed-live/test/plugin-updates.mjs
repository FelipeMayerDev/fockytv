import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { once } from "node:events"
import test from "node:test"
import express from "express"
import { WebSocket } from "ws"
import { createPluginUpdates } from "../plugin-updates.js"

test("signed main pushes reach all subscribers; invalid, duplicate and other events cannot broadcast", async t => {
  const secret = "local-test-secret"
  const app = express()
  const updates = createPluginUpdates(app, { secret })
  app.use(express.json()) // The webhook must see raw bytes before this parser.
  const server = app.listen(0, "127.0.0.1")
  server.on("upgrade", updates.upgrade)
  await once(server, "listening")
  const base = `http://127.0.0.1:${server.address().port}`
  const clients = [new WebSocket(base.replace("http", "ws")), new WebSocket(base.replace("http", "ws"))]
  const messages = [[], []]
  clients.forEach((ws, i) => ws.on("message", raw => messages[i].push(JSON.parse(raw))))
  t.after(async () => { clients.forEach(ws => ws.terminate()); updates.close(); await new Promise(resolve => server.close(resolve)) })
  await Promise.all(clients.map(ws => once(ws, "open")))
  let sequence = 0
  const payload = { repository: { full_name: "FelipeMayerDev/fockytv-vencord-plugin" }, ref: "refs/heads/main", after: "a".repeat(40), deleted: false }
  const send = async (value, headers = {}) => {
    const body = typeof value === "string" ? value : JSON.stringify(value)
    return fetch(`${base}/api/fixed/plugin-updates/webhook`, { method: "POST", headers: {
      "Content-Type": "application/json", "X-GitHub-Event": "push", "X-GitHub-Delivery": `test-${++sequence}`,
      "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`, ...headers
    }, body })
  }
  assert.equal((await send(payload, { "X-Hub-Signature-256": "sha256=" + "0".repeat(64) })).status, 401)
  assert.equal((await send(payload, { "X-Hub-Signature-256": "bad" })).status, 401)
  assert.equal((await send("bad JSON")).status, 400)
  assert.equal((await send(null)).status, 204)
  assert.equal((await send({ ...payload, ref: "refs/heads/feature" })).status, 204)
  assert.equal((await send({ ...payload, repository: { full_name: "other/repo" } })).status, 204)
  assert.equal((await send({ ...payload, deleted: true })).status, 204)
  assert.equal((await send({ ...payload, after: "../../invalid" })).status, 400)
  assert.equal((await send(payload, { "X-GitHub-Event": "issues" })).status, 204)
  assert.equal((await send({}, { "X-GitHub-Event": "ping" })).status, 200)
  assert.equal((await send(payload, { "X-GitHub-Delivery": "" })).status, 400)
  assert.deepEqual(messages, [[], []])
  const received = Promise.all(clients.map(ws => once(ws, "message")))
  assert.equal((await send(payload, { "X-GitHub-Delivery": "first" })).status, 202)
  await received
  assert.deepEqual(messages, [[{ type: "plugin-update", revision: payload.after }], [{ type: "plugin-update", revision: payload.after }]])
  assert.equal((await send(payload, { "X-GitHub-Delivery": "first" })).status, 204)
  assert.equal(messages[0].length, 1)
  const pr = { repository: payload.repository, action: "opened", pull_request: { number: 42, title: "Fix CI", merged: false } }
  const run = { repository: payload.repository, action: "completed", workflow_run: { id: 99, name: "CI", head_branch: "main", conclusion: "failure", head_repository: payload.repository } }
  for (const event of ["pull_request", "workflow_run"]) {
    const value = event === "pull_request" ? pr : run
    assert.equal((await send(value, { "X-GitHub-Event": event, "X-Hub-Signature-256": "bad" })).status, 401)
    assert.equal((await send({ ...value, repository: { full_name: "other/repo" } }, { "X-GitHub-Event": event })).status, 204)
    assert.equal((await send(value, { "X-GitHub-Event": event, "X-GitHub-Delivery": "" })).status, 400)
  }
  for (const action of ["reopened", "synchronize", "closed"]) assert.equal((await send({ ...pr, action }, { "X-GitHub-Event": "pull_request" })).status, 204)
  for (const changes of [{ head_branch: "feature" }, { conclusion: "success" }, { conclusion: "cancelled" }, { head_repository: { full_name: "fork/repo" } }, { head_repository: null }]) {
    assert.equal((await send({ ...run, workflow_run: { ...run.workflow_run, ...changes } }, { "X-GitHub-Event": "workflow_run" })).status, 204)
  }
  assert.equal((await send({ ...run, action: "in_progress" }, { "X-GitHub-Event": "workflow_run" })).status, 204)
  for (const changes of [{ number: 0 }, { number: "42" }, { title: null }]) {
    assert.equal((await send({ ...pr, pull_request: { ...pr.pull_request, ...changes } }, { "X-GitHub-Event": "pull_request" })).status, 400)
  }
  assert.equal((await send({ ...run, workflow_run: { ...run.workflow_run, id: -1 } }, { "X-GitHub-Event": "workflow_run" })).status, 400)
  assert.equal(messages[0].length, 1, "Ignored events cannot broadcast")
  for (const [event, value, kind, id, title] of [
    ["pull_request", pr, "pr-opened", 42, "Fix CI"],
    ["pull_request", { ...pr, action: "closed", pull_request: { ...pr.pull_request, merged: true } }, "pr-merged", 42, "Fix CI"],
    ["workflow_run", run, "workflow-failed", 99, "CI"]
  ]) {
    const delivery = `alert-${kind}`
    const receivedAlert = Promise.all(clients.map(ws => once(ws, "message")))
    assert.equal((await send(value, { "X-GitHub-Event": event, "X-GitHub-Delivery": delivery })).status, 202)
    await receivedAlert
    for (const list of messages) assert.deepEqual(list.at(-1), { type: "github-event", kind, id, title, delivery })
    const count = messages[0].length
    assert.equal((await send(value, { "X-GitHub-Event": event, "X-GitHub-Delivery": delivery })).status, 204)
    assert.equal(messages[0].length, count)
  }
  const pong = once(clients[0], "message")
  clients[0].send('{"type":"ping"}')
  assert.deepEqual(JSON.parse((await pong)[0]), { type: "pong" })
  const next = Promise.all(clients.map(ws => once(ws, "message")))
  assert.equal((await send({ ...payload, after: "b".repeat(40) })).status, 202)
  await next
  assert.equal(messages[0].at(-1).revision, "b".repeat(40))
})

test("missing secret disables webhook ingestion", async t => {
  const app = express()
  const updates = createPluginUpdates(app, { secret: "" })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(async () => { updates.close(); await new Promise(resolve => server.close(resolve)) })
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/fixed/plugin-updates/webhook`, { method: "POST" })).status, 503)
})
