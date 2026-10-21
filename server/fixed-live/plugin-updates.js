// Pushes assinados do GitHub viram apenas avisos; nenhum código é instalado no servidor.
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
      if (req.get("x-github-event") !== "push") return res.sendStatus(204)
      let payload
      try { payload = JSON.parse(req.body) } catch { return res.sendStatus(400) }
      if (payload?.repository?.full_name !== "FelipeMayerDev/fockytv-vencord-plugin" || payload.ref !== "refs/heads/main" || payload.deleted) return res.sendStatus(204)
      if (typeof payload.after !== "string" || !/^[a-f0-9]{40}$/.test(payload.after)) return res.sendStatus(400)
      const delivery = req.get("x-github-delivery")
      if (!delivery || delivery.length > 128) return res.sendStatus(400)
      if (deliveries.has(delivery)) return res.sendStatus(204)
      deliveries.add(delivery)
      if (deliveries.size > 1000) deliveries.delete(deliveries.values().next().value)
      const message = JSON.stringify({ type: "plugin-update", revision: payload.after })
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
