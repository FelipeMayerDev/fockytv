# FockyTV

Low-latency, high-quality screen sharing you host yourself. Replaces OBS with a
purpose-built client. Server and client are separate.

The server is [MediaMTX](https://github.com/bluenviron/mediamtx) (media engine:
WHIP in / WHEP out, relay only — no transcode) behind a small Go adapter,
`server/live-api`, which preserves the API surface the clients already speak
(`/api/whip`, `/api/whep?viewer=`, `/api/status`, `/api/fixed/*`). The client is
Electron: UI and WebRTC only, with no embedded server.

```
┌─ CLIENT (win + linux) ────────┐      ┌─ SERVER (docker) ─────────────────┐
│  Share      ── WHIP ────────────────▶  live-api  :8080 (HTTP, sinalização)│
│  Live grid  ── WHEP ◀───────────────   mediamtx :8180/udp (mídia ICE)     │
└───────────────────────────────┘      └───────────────────────────────────┘
        Signaling via live-api · media flows straight to the UDP mux
```

---

## Server

```bash
cd server
docker compose up -d
curl localhost:8180/api/status     # [] = up, nobody streaming
```

Listens on `localhost:8180`. The web interface lives at
<http://localhost:8180/> — the same interface as the desktop app, including
publishing and watching streams.

### Exposing it publicly

Point `MTX_ADDITIONAL_HOSTS` (compose env) at the IP clients can actually
reach — that is the ICE candidate MediaMTX advertises in the SDP. On the VPS
that is the public IP (`192.3.176.195`); on the LAN, the host IP
(`192.168.1.129`). Docker-bridge IPs are advertised too (`webrtcIPsFromInterfaces`)
and that is by design: the `fixed-live` recorder reads the stream from inside
the compose network through them, with no hairpin.

Verify:

- `curl http://<public-ip>:8180/api/status` answers **from outside your network**
- Publish from another network (phone hotspot works) and watch
- In the SDP's ICE candidates the IP must be the public one — not `172.x`, not `192.168.x`

---

## Client

```bash
# no local Node toolchain needed
docker run --rm -v "$PWD:/app" -w /app -u "$(id -u):$(id -g)" \
  -e HOME=/app/.cache node:22 npm install

./node_modules/.bin/electron .
```

### Pointing the client at the server

**The client does not discover the server.** Docker Compose only publishes port
8080 on the host; nothing wires that to the client. The address is read from
`config.json`:

```json
{ "serverUrl": "http://localhost:8080", "displayName": "focky" }
```

`localhost` only works for whoever runs the server on their own machine. Once
the playit tunnel is up, set `serverUrl` to `http://<public-ip>:<tcp-port>`
before building, so shipped binaries point at the right place out of the box.

`displayName` is only the initial suggestion — the nickname is stored in
`localStorage` after the first run and changed from the UI. The nickname doubles
as the stream key.

### Using it

The default screen is a grid of everyone currently live, with thumbnails,
viewer count and uptime. **Share screen** is in the header; while broadcasting
it is replaced by a live indicator plus buttons to swap the shared
window/screen (without dropping viewers) and to stop.

The share dialog offers frame rate (15/30/60), codec, and a system-audio
toggle. On Wayland the source list comes from the system portal instead of an
in-app grid — see the pitfalls below.

Closing the window hides the app to the system tray rather than quitting, so a
broadcast survives getting the window out of the way. Quit from the tray menu.
On Linux this needs a StatusNotifierItem host (most bars ship one; check with
`busctl --user list | grep StatusNotifierWatcher`) — without it the icon simply
never appears and the window has no way back.

### Packaging

```bash
make run        # open the client
make linux      # AppImage        -> dist/
make windows    # NSIS installer  -> dist/
make release    # build both and publish to GitHub Releases (needs GH_TOKEN)
```

Everything runs in containers — `node_modules` is installed in one too, and is
only rebuilt when `package.json` changes. The Electron window itself opens on
your desktop, since a GUI in a container would defeat the point.

### Where config.json is read from

First match wins:

1. `<userData>/config.json` — survives updates, so this is the durable override
   (`~/.config/fockytv/` on Linux, `%APPDATA%\fockytv\` on Windows)
2. Next to the executable — `$APPIMAGE`'s directory, or the install directory.
   Note the NSIS installer rewrites its own directory on every update, so an
   override there is **not** durable on Windows
3. The bundled default, which is what you set at build time

For a single shared server, setting `serverUrl` before building is enough and
nobody has to edit anything.

### Updates

The client checks GitHub Releases on launch and every 6 hours. A new version
downloads in the background and a toast offers a restart; nothing is applied
mid-broadcast unless you click it. Supported on AppImage and NSIS — the
`portable` Windows target cannot auto-update, which is why NSIS is the target
here.

`config.json` lives outside the application bundle, so updates replace the code
and leave the server URL alone.

To ship a release: bump `version` in `package.json`, then `GH_TOKEN=... make
release`. electron-builder creates the tag, uploads both artifacts and the
`latest*.yml` manifests the updater reads.

---

## Design decisions

| Decision | Why |
|---|---|
| Electron, not Tauri | Tauri's Linux webview is the **system** WebKitGTK — `getDisplayMedia` varies by distro, and the whole app depends on it. Cost: ~104 MB of Chromium in the bundle. |
| MediaMTX + live-api, not a fork | The media engine is stock [MediaMTX](https://github.com/bluenviron/mediamtx) (pinned image) — relay only, no transcode, actively maintained. The FockyTV-specific layer lives in `server/live-api` (~500 lines of Go): it keeps the broadcast-box-shaped API (`/api/whip`, `/api/whep?viewer=`, `/api/status`), enforces the takeover rule (a new publisher on the same key is rejected while the current one is sending RTP; a ghost cedes), tracks viewer identities and proxies `/api/fixed/*`. Clients were written once against that API and survive server swaps. |
| No TURN | The topology is client-server, not P2P. Peers behind NAT already work: the connection is outbound. |
| UDP only | The media mux is UDP (`8180/udp`). ICE-over-TCP (MediaMTX's `webrtcLocalTCPAddress`) adds progressive delay under congestion and was never reachable through the old port mapping anyway. |
| shadcn without React | Uses shadcn's design tokens and component CSS (dark zinc; Button/Card/Dialog/Select/Switch/Skeleton). The real library would mean React + Tailwind + a bundler for a single-file renderer. |
| Thumbnails over WHEP | The grid connects hidden, grabs the first frame, disconnects. No new server endpoint. Cheap for 1–5 streams, not for 50. |
| NSIS over portable on Windows | `electron-updater` cannot update a `portable` .exe. Auto-update was worth more than copy-and-run. |
| 60 fps ceiling | The limit is Chromium's capture path, not the hardware. Going higher needs native capture (DXGI/WGC on Windows, PipeWire directly on Linux) outside the browser — a different project. |

The stream key **is** the nickname, and the nickname is the publishing
credential: anyone who knows the name can broadcast as that person. Fine among
friends. If this ever opens up, separate key from name and sign it server-side.

---

## Pitfalls

These cost real time. Read before debugging.

**ICE candidates: advertise the IP clients reach.** `MTX_WEBRTCADDITIONALHOSTS`
must be the IP a viewer actually dials (public IP on the VPS, host IP on the
LAN). Symptom when wrong: signaling fine, ICE stuck in `checking` forever,
black video. The docker-bridge IP is also advertised on purpose — that is the
one the in-network recorder uses.

**Call `setParameters` after `addTrack`.** Before that,
`getParameters().encodings` is empty and your configuration is silently
discarded. Symptom: bitrate pinned near 2.5 Mbps.

**Non-trickle ICE.** Send the offer with candidates already in it (the UI and
the Rust client both wait for `iceGatheringState === 'complete'`). MediaMTX
accepts trickle too, but every FockyTV client is non-trickle by design.

**Secure context.** `getDisplayMedia` only runs on `https://`, `localhost` or
`file://`. `http://192.168.x` does **not** work.

**`degradationPreference: 'maintain-resolution'`.** Without it Chromium drops
resolution at the first sign of CPU pressure. It is the most common cause of
"it suddenly went blurry".

**WHIP/WHEP sessions need an explicit `DELETE`.** The `POST` returns
`Location: /api/whip/<id>`; closing only the `RTCPeerConnection` leaves the
stream listed until ICE times out. The `DELETE` requires the **same bearer
token** as the `POST` — without it you get `400 Authorization was not set` and
the request is rejected silently.

**Wayland: `desktopCapturer.getSources()` *is* the picker.** It does not
enumerate screens and windows — it returns one generic unnamed entry, and the
system portal does the choosing during that call. The app only renders its own
grid when the list is real (Windows).

**Wayland: never set `thumbnailSize` to `0x0`.** It looks like a free
optimization when the list is never displayed. It is not: the PipeWire capturer
dies right after the first call (measured, 4 runs out of 4). The ~2s per call is
the portal's price, and thumbnails are not what costs it.

**Wayland: don't call `getSources()` while a capture is live.** The portal
refuses the second session. Swapping the shared window releases the current
source first; the WHIP connection stays up, so viewers only see a freeze.

**Wayland: source ids don't survive between calls.** Every `getSources()` opens
a fresh portal session. Resolving an id against a stale list yields `undefined`
and `getDisplayMedia` fails with `NotAllowedError`. The main process caches the
last list and resolves against it.

**`[hidden]` loses to an explicit `display`.** With `button { display:inline-flex }`
in your CSS, the `hidden` attribute hides nothing. The reset carries
`[hidden] { display:none !important }`.

**`* { margin:0 }` un-centers `<dialog>`.** Browsers center modals with
`margin:auto`; the reset was zeroing it.

---

## Roadmap

Shipped in phases, one commit each. Checked items are done.

- [x] **Phase 0 — Foundation.** SQLite in the `fixed-live` sidecar on a compose
      volume (everything is in-memory today) + a settings dialog in the client
      (`localStorage` toggles) for the features below.
- [x] **Phase 1 — Music channel history.** Every track played on the fixed
      music channel (what, who asked, when) listed per week with a YouTube
      link — a shared playlist for the group.
- [x] **Phase 2 — Global live chat.** Persistent chat next to the player,
      visible on every stream (Twitch-style), server-side relay with history.
- [x] **Phase 3 — Discord integration.** Server-side webhook announcing
      "fulano is live" when someone starts broadcasting, plus client Rich
      Presence ("watching X's channel on FockyTV"). Both toggleable.
- [x] **Phase 4 — Clip buffer.** The sidecar consumes each live as a WHEP
      viewer and keeps a rolling segment buffer (~90 s); lives are not
      recorded anymore — the "Clips" tab lists saved cuts only.
- [x] **Phase 5 — Clips.** Watching a live, a button grabs the last 30 s from
      the rolling buffer and opens a trim modal. Clips get a shareable link
      and live in the Clips tab.
- [ ] **Phase 6 — "You missed it" digest.** Once-a-day modal on launch:
      "last night had 14 songs played and 3 clips cut", click to open.
      Toggleable.
- [ ] **Phase 7 — Game mode.** Game-window capture priority + capture only the
      game's audio (the WASAPI helper already does per-process loopback, used
      in exclude mode today) + an on-stream overlay listing who's watching.

---

## Out of scope

Auth beyond the bearer token · simulcast layer switching · transcoding ·
mobile · multiple simultaneous screens · embedded server in the client ·
system audio on Linux (needs PipeWire; on Windows it is `audio: 'loopback'`)
