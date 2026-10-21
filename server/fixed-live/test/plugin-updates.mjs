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
