// Eventos assinados do GitHub viram apenas avisos; nenhum código é instalado no servidor.
import { createHmac, timingSafeEqual } from "node:crypto"
import express from "express"
import { WebSocketServer, WebSocket } from "ws"

export function createPluginUpdates(app, { secret = process.env.GITHUB_WEBHOOK_SECRET ?? "" } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 })
  const deliveries = new Set()
  wss.on("error", e => console.warn("[plugin-updates] websocket:", e.message))
  wss.on("connection", ws => {
    ws.on("error", () => {})
    ws.on("message", data => {
      if (data.toString() === '{"type":"ping"}') ws.send('{"type":"pong"}')
    })
  })
  app.post("/api/fixed/plugin-updates/webhook", (req, res, next) => secret ? next() : res.sendStatus(503),
    express.raw({ type: "application/json", limit: "25mb" }), (req, res) => {
      const signature = req.get("x-hub-signature-256") ?? ""
      if (!Buffer.isBuffer(req.body) || !/^sha256=[a-f0-9]{64}$/.test(signature)) return res.sendStatus(401)
      const expected = createHmac("sha256", secret).update(req.body).digest()
      if (!timingSafeEqual(Buffer.from(signature.slice(7), "hex"), expected)) return res.sendStatus(401)
      if (req.get("x-github-event") === "ping") return res.sendStatus(200)
      const event = req.get("x-github-event")
      if (!["push", "pull_request", "workflow_run"].includes(event)) return res.sendStatus(204)
      let payload
      try { payload = JSON.parse(req.body) } catch { return res.sendStatus(400) }
      if (payload?.repository?.full_name !== "FelipeMayerDev/fockytv-vencord-plugin") return res.sendStatus(204)
      let notification
      if (event === "push") {
        if (payload.ref !== "refs/heads/main" || payload.deleted) return res.sendStatus(204)
        if (typeof payload.after !== "string" || !/^[a-f0-9]{40}$/.test(payload.after)) return res.sendStatus(400)
        notification = { type: "plugin-update", revision: payload.after }
      } else {
        let kind, id, title
        if (event === "pull_request") {
          if (payload.action === "opened") kind = "pr-opened"
          else if (payload.action === "closed" && payload.pull_request?.merged === true) kind = "pr-merged"
          else return res.sendStatus(204)
          id = payload.pull_request?.number
          title = payload.pull_request?.title
        } else {
          const run = payload.workflow_run
          if (payload.action !== "completed" || run?.head_branch !== "main" || run.conclusion !== "failure") return res.sendStatus(204)
          // Um PR de fork também pode ter uma branch chamada main.
          if (run.head_repository?.full_name !== "FelipeMayerDev/fockytv-vencord-plugin") return res.sendStatus(204)
          kind = "workflow-failed"
          id = run.id
          title = run.name
        }
        if (!Number.isSafeInteger(id) || id <= 0 || typeof title !== "string" || !title.trim()) return res.sendStatus(400)
        notification = { type: "github-event", kind, id, title: title.slice(0, 300) }
      }
      const delivery = req.get("x-github-delivery")
      if (!delivery || delivery.length > 128) return res.sendStatus(400)
      if (deliveries.has(delivery)) return res.sendStatus(204)
      deliveries.add(delivery)
      if (deliveries.size > 1000) deliveries.delete(deliveries.values().next().value)
      const message = JSON.stringify(notification.type === "github-event" ? { ...notification, delivery } : notification)
      for (const ws of wss.clients) {
        if (ws.bufferedAmount > 65536) ws.terminate()
        else if (ws.readyState === WebSocket.OPEN) ws.send(message)
      }
      res.sendStatus(202)
    })
  return {
    upgrade: (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req)),
    close: callback => wss.close(callback)
  }
}
