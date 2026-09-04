# FockyTV

Low-latency, high-quality screen sharing you host yourself. Replaces OBS with a
purpose-built client. Server and client are separate.

The server is [broadcast-box](https://github.com/Glimesh/broadcast-box) (Pion,
WHIP in / WHEP out) running in Docker — no fork. The client is Electron: UI and
WebRTC only, with no embedded server.

```
┌─ CLIENT (win + linux) ────────┐        ┌─ SERVER (docker) ────────┐
│  Share      ── WHIP ──────────────────▶  broadcast-box            │
│  Live grid  ── WHEP ◀─────────────────   :8080 http + udp mux     │
└───────────────────────────────┘        └──────────────────────────┘
                                              ▲ (optional) playit.gg
```

---

## Server

```bash
cd server
docker compose up -d
curl localhost:8080/api/status     # [] or null = up, nobody streaming
```

Listens on `localhost:8080`. A measurement bench lives at
<http://localhost:8080/fase0.html> — it publishes, watches, and reports
resolution, fps, bitrate and `qualityLimitationReason` without needing
`chrome://webrtc-internals`.

### Exposing it publicly with playit.gg

The `playit` service is commented out in `server/docker-compose.yml`. Uncomment
it and follow **this order** — doing it backwards fails in a way that is hard to
debug.

1. In the playit.gg dashboard, create a **UDP** tunnel. It assigns a public
   port, e.g. `45678`. Point the destination at `127.0.0.1:45678` — **the local
   port must match the public one.**
2. Create a **TCP** tunnel for HTTP, destination `127.0.0.1:8080`.
3. Grab your secret from playit.gg → Account → Secret Key.
4. Fill in `.env` (copy `.env.example`):

   ```ini
   UDP_MUX_PORT=45678        # = playit's public UDP port
   NAT_1_TO_1_IP=1.2.3.4     # = playit's public IP
   PLAYIT_SECRET=...
   ```

5. `docker compose --profile tunnel up -d`

Verify:

- `curl http://<public-ip>:<tcp-port>/api/status` answers **from outside your network**
- Publish from another network (phone hotspot works) and watch
- In the SDP's ICE candidates the IP must be the public one — not `172.x`, not `192.168.x`

Measure the bitrate again here and compare it against the localhost number.
playit relays traffic through their network; if it drops a lot, the tunnel is
your ceiling and a VPS with a direct public IP is worth considering.

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
| No broadcast-box fork | Deleting code doesn't justify carrying a rebase forever. Fork only to **add** something. |
| No TURN | The topology is client-server, not P2P. Peers behind NAT already work: the connection is outbound. |
| TCP fallback, no toggle | With `NETWORK_TYPES=udp4\|tcp4`, ICE picks on its own. |
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

**playit's port ≠ your local port.** `NAT_1_TO_1_IP` rewrites only the **IP** in
ICE candidates, never the port. Public `45678` with local `8081` makes the SDP
advertise `ip:8081` and media never connects. Symptom: signaling fine, ICE stuck
in `checking` forever, black video.

**`NETWORK_TYPES` is `|`-separated, not comma-separated.**

**Call `setParameters` after `addTrack`.** Before that,
`getParameters().encodings` is empty and your configuration is silently
discarded. Symptom: bitrate pinned near 2.5 Mbps.

**Non-trickle ICE.** broadcast-box wants the offer with candidates already in
it. Always wait for `iceGatheringState === 'complete'` before sending the SDP.

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

## Out of scope

Recording · chat · auth beyond the bearer token · simulcast layer switching ·
transcoding · mobile · multiple simultaneous screens · embedded server in the
client · system audio on Linux (needs PipeWire; on Windows it is
`audio: 'loopback'`)
