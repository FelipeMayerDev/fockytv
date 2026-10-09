// live-api: a porta de entrada HTTP do FockyTV, na frente do MediaMTX.
// Preserva a API que o client Rust, a UI e o fixed-live já falam (herança do
// broadcast-box): /api/whip, /api/whep?viewer=, /api/status, /api/fixed/* e
// os estáticos da ui/. A mídia nunca passa por aqui — ICE/UDP vai direto ao
// mediamtx; este processo é sinalização + registro de quem assiste.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// mesmo alfabeto de nick/stream key do broadcast-box (viewer-identity)
var keyRe = regexp.MustCompile(`^[\w.-]{1,32}$`)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

var (
	mtxWebRTC = env("MTX_WEBRTC", "http://mediamtx:8889")
	mtxAPI    = env("MTX_API", "http://mediamtx:9997")
	mtxUser   = env("MTX_USER", "liveapi")
	mtxPass   = env("MTX_PASS", "fockytv-internal")
	fixedURL  = env("FIXED_LIVE_URL", "")
	staticDir = env("STATIC_DIR", "/srv/ui")
	dlDir     = env("DOWNLOAD_DIR", "/srv/download")
	listen    = env("LISTEN", ":8080")

	pollEvery   = 3 * time.Second  // amostragem do /v3 (o status da UI polla a cada 5s)
	ghostWindow = 10 * time.Second // sem RTP neste intervalo = publisher fantasma
)

// codecs que contam como trilha no /api/status (a UI e o watchdog do
// fixed-live só olham o length dos arrays)
var (
	videoCodecs = map[string]bool{"H264": true, "H265": true, "H266": true, "AV1": true, "VP8": true, "VP9": true}
	audioCodecs = map[string]bool{"OPUS": true, "G711": true, "G722": true, "L16": true}
)

// ── estado compartilhado (alimentado pelo poller do /v3) ─────────────────

type mtxReader struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type mtxPath struct {
	Name         string      `json:"name"`
	Ready        bool        `json:"ready"`
	ReadyTime    string      `json:"readyTime"`
	Source       *mtxReader  `json:"source"`
	Tracks       []string    `json:"tracks"`
	Readers      []mtxReader `json:"readers"`
	InboundBytes uint64      `json:"inboundBytes"`
}

// sessão de sinalização registrada pelo adapter
type session struct {
	kind      string // "whip" | "whep"
	path      string // path no mediamtx (== stream key)
	nick      string // bearer que criou (whip: publicador; whep: key assistida)
	viewer    string // whep: ?viewer=
	location  string // recurso da sessão no mediamtx (requestURI)
	id        string // uuid que o adapter entregou na Location
	createdAt time.Time
}

type app struct {
	http *http.Client

	mu       sync.Mutex
	paths    map[string]*mtxPath              // última amostra do /v3
	lastB    map[string]uint64                // path → inboundBytes da amostra anterior
	lastMed  map[string]time.Time             // path → última vez que os bytes cresceram
	sessions map[string]*session              // id → sessão
	byPath   map[string]map[*session]struct{} // whep por path (poda/status)
}

func newApp() *app {
	return &app{
		http:     &http.Client{Timeout: 20 * time.Second},
		paths:    map[string]*mtxPath{},
		lastB:    map[string]uint64{},
		lastMed:  map[string]time.Time{},
		sessions: map[string]*session{},
		byPath:   map[string]map[*session]struct{}{},
	}
}

func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func bearer(r *http.Request) string {
	return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
}

// ── poller: amostra o /v3 do mediamtx e poda sessões fantasmas ───────────

func (a *app) pollLoop() {
	for {
		a.poll()
		time.Sleep(pollEvery)
	}
}

func (a *app) poll() {
	req, err := http.NewRequest("GET", mtxAPI+"/v3/paths/list", nil)
	if err != nil {
		return
	}
	req.SetBasicAuth(mtxUser, mtxPass)
	res, err := a.http.Do(req)
	if err != nil {
		log.Printf("[poll] mediamtx api: %v", err)
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		log.Printf("[poll] mediamtx api: %s", res.Status)
		return
	}
	var list struct {
		Items []mtxPath `json:"items"`
	}
	if err := json.NewDecoder(res.Body).Decode(&list); err != nil {
		return
	}

	now := time.Now()
	paths := map[string]*mtxPath{}
	for i := range list.Items {
		p := &list.Items[i]
		paths[p.Name] = p
		a.mu.Lock()
		if p.InboundBytes > a.lastB[p.Name] {
			a.lastMed[p.Name] = now // RTP chegando = publisher vivo
		}
		a.lastB[p.Name] = p.InboundBytes
		a.mu.Unlock()
	}

	// poda de viewers fantasmas: a sessão WHEP some do mediamtx quando o ICE
	// cai, mas o reader id não é o id do recurso HTTP que a gente entregou
	// (namespaces distintos) — sobra reconciliar por contagem: se registrei
	// mais sessões do que readers vivos na path, os mais antigos eram os
	// fantasmas. DELETEs podam com precisão no ato.
	a.mu.Lock()
	defer a.mu.Unlock()
	a.paths = paths
	perPath := map[string][]*session{}
	for _, s := range a.sessions {
		if s.kind == "whep" {
			perPath[s.path] = append(perPath[s.path], s)
		}
	}
	for path, ss := range perPath {
		live := 0
		if p := paths[path]; p != nil {
			live = len(p.Readers)
		}
		if len(ss) <= live {
			continue
		}
		sort.Slice(ss, func(i, j int) bool { return ss[i].createdAt.Before(ss[j].createdAt) })
		for _, ghost := range ss[:len(ss)-live] {
			a.drop(ghost)
		}
	}
}

// drop remove a sessão do registro. Chamador segura a.mu.
func (a *app) drop(s *session) {
	delete(a.sessions, s.id)
	if m := a.byPath[s.path]; m != nil {
		delete(m, s)
		if len(m) == 0 {
			delete(a.byPath, s.path)
		}
	}
}

// lastMediaAt: quando os bytes da path cresceram pela última vez (nil = nunca)
func (a *app) lastMediaAt(path string) *time.Time {
	a.mu.Lock()
	defer a.mu.Unlock()
	if t, ok := a.lastMed[path]; ok {
		return &t
	}
	return nil
}

// ── sinalização WHIP/WHEP pro mediamtx ───────────────────────────────────

// mtxSignal faz o POST do SDP (offer) e devolve (status, location, body).
func (a *app) mtxSignal(kind, path string, r *http.Request) (int, string, []byte) {
	req, err := http.NewRequestWithContext(r.Context(), "POST",
		mtxWebRTC+"/"+path+"/"+kind, r.Body)
	if err != nil {
		return 500, "", []byte(err.Error())
	}
	req.Header.Set("Content-Type", "application/sdp")
	req.SetBasicAuth(mtxUser, mtxPass)
	res, err := a.http.Do(req)
	if err != nil {
		return 502, "", []byte("mediamtx: " + err.Error())
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	loc := res.Header.Get("Location")
	if loc != "" {
		// o Location pode vir relativo ou absoluto; guardamos só o requestURI
		if u, err := url.Parse(loc); err == nil {
			loc = u.RequestURI()
		}
	}
	return res.StatusCode, loc, body
}

func (a *app) whipPost(w http.ResponseWriter, r *http.Request) {
	nick := bearer(r)
	if !keyRe.MatchString(nick) {
		http.Error(w, "stream key inválida", http.StatusBadRequest)
		return
	}
	streams, err := a.livekitStreams(r.Context())
	if err != nil {
		http.Error(w, "LiveKit indisponível", http.StatusServiceUnavailable)
		return
	}
	for _, stream := range streams {
		if stream.StreamKey == nick {
			http.Error(w, "session already has a host (active)", http.StatusBadRequest)
			return
		}
	}
	// regra do host-takeover (mesma string que fixed-live e o client Rust
	// esperam): publisher com RTP recente segura o lugar; fantasma cede.
	if t := a.lastMediaAt(nick); t != nil && time.Since(*t) < ghostWindow {
		http.Error(w, "session already has a host (active)", http.StatusBadRequest)
		return
	}
	status, loc, body := a.mtxSignal("whip", nick, r)
	if status != http.StatusCreated {
		w.WriteHeader(status)
		w.Write(body)
		return
	}
	uuid := newUUID()
	a.mu.Lock()
	// um publicador por path: sessões whip antigas da path morreram no
	// override do mediamtx — limpa o registro delas
	for _, s := range a.sessions {
		if s.kind == "whip" && s.path == nick {
			a.drop(s)
		}
	}
	a.sessions[uuid] = &session{kind: "whip", path: nick, nick: nick, location: loc, id: uuid, createdAt: time.Now()}
	a.mu.Unlock()
	log.Printf("[whip] publish path=%s id=%s", nick, uuid)

	w.Header().Set("Location", "/api/whip/"+uuid)
	w.Header().Set("Content-Type", "application/sdp")
	w.WriteHeader(status)
	w.Write(body)
}

func (a *app) whepPost(w http.ResponseWriter, r *http.Request) {
	key := bearer(r)
	viewer := r.URL.Query().Get("viewer")
	if !keyRe.MatchString(key) || (viewer != "" && !keyRe.MatchString(viewer)) {
		http.Error(w, "stream key inválida", http.StatusBadRequest)
		return
	}
	status, loc, body := a.mtxSignal("whep", key, r)
	if status != http.StatusCreated {
		// ex.: 404 "no stream is available" quando a stream não está no ar —
		// mesmo comportamento do broadcast-box pra UI
		w.WriteHeader(status)
		w.Write(body)
		return
	}
	uuid := newUUID()
	a.mu.Lock()
	s := &session{kind: "whep", path: key, nick: key, viewer: viewer, location: loc, id: uuid, createdAt: time.Now()}
	a.sessions[uuid] = s
	if a.byPath[key] == nil {
		a.byPath[key] = map[*session]struct{}{}
	}
	a.byPath[key][s] = struct{}{}
	a.mu.Unlock()
	log.Printf("[whep] read path=%s viewer=%q id=%s", key, viewer, uuid)

	w.Header().Set("Location", "/api/whep/"+uuid)
	w.Header().Set("Content-Type", "application/sdp")
	w.WriteHeader(status)
	w.Write(body)
}

func (a *app) sessDelete(prefix string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		a.mu.Lock()
		s := a.sessions[id]
		if s == nil {
			a.mu.Unlock()
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		// o DELETE exige o mesmo bearer do POST (contrato do broadcast-box)
		if bearer(r) != s.nick {
			a.mu.Unlock()
			http.Error(w, "Authorization was not set", http.StatusBadRequest)
			return
		}
		loc := s.location
		a.drop(s)
		a.mu.Unlock()
		log.Printf("[%s] close path=%s id=%s", s.kind, s.path, id)

		target := mtxWebRTC + loc
		if s.kind == "livekit-whip" {
			target = loc
		}
		req, err := http.NewRequestWithContext(r.Context(), "DELETE", target, nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		req.SetBasicAuth(mtxUser, mtxPass)
		res, err := a.http.Do(req)
		if err != nil {
			http.Error(w, "mediamtx: "+err.Error(), http.StatusBadGateway)
			return
		}
		defer res.Body.Close()
		w.WriteHeader(res.StatusCode)
	}
}

// ── /api/status: o formato que a UI e o watchdog do fixed-live consomem ──

type sessState struct {
	ID     string `json:"id"`
	Viewer string `json:"viewer,omitempty"`
}

type trackState map[string]any

type streamState struct {
	Engine      string       `json:"engine,omitempty"`
	StreamKey   string       `json:"streamKey"`
	IsPublic    bool         `json:"isPublic"`
	Motd        string       `json:"motd"`
	StreamStart string       `json:"streamStart"`
	AudioTracks []trackState `json:"audioTracks"`
	VideoTracks []trackState `json:"videoTracks"`
	Sessions    []sessState  `json:"sessions"`
}

func (a *app) status(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	lk, err := a.livekitStreams(r.Context())
	if err != nil {
		log.Printf("[livekit] status: %v", err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	out := lk
	if out == nil {
		out = make([]streamState, 0)
	}
	for _, p := range a.paths {
		if !p.Ready {
			continue
		}
		st := streamState{
			StreamKey:   p.Name,
			IsPublic:    true,
			StreamStart: truncMs(p.ReadyTime),
			AudioTracks: []trackState{},
			VideoTracks: []trackState{},
			Sessions:    []sessState{},
		}
		for _, c := range p.Tracks {
			entry := trackState{"rid": "", "packetsReceived": 0, "packetsDropped": 0}
			switch {
			case videoCodecs[c]:
				st.VideoTracks = append(st.VideoTracks, entry)
			case audioCodecs[c]:
				st.AudioTracks = append(st.AudioTracks, entry)
			}
		}
		for s := range a.byPath[p.Name] {
			st.Sessions = append(st.Sessions, sessState{ID: s.id, Viewer: s.viewer})
		}
		sort.Slice(st.Sessions, func(i, j int) bool { return st.Sessions[i].ID < st.Sessions[j].ID })
		out = append(out, st)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StreamKey < out[j].StreamKey })
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// truncMs mantém o readyTime em RFC3339 com 3 casas — o status só faz
// new Date(iso), e nanossegundos incomodam parsers mais rígidos.
func truncMs(iso string) string {
	dot := strings.Index(iso, ".")
	if dot < 0 {
		return iso
	}
	frac := iso[dot+1:]
	for i, c := range frac {
		if c < '0' || c > '9' {
			frac = frac[:i]
			break
		}
	}
	if len(frac) > 3 {
		frac = frac[:3]
	}
	return iso[:dot+1] + frac + "Z"
}

// ── middleware e main ────────────────────────────────────────────────────

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Expose-Headers", "Location")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, PATCH, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	a := newApp()
	go a.pollLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/status", a.status)
	mux.HandleFunc("POST /api/livekit/join", a.livekitJoin)
	mux.HandleFunc("POST /api/livekit/whip", a.livekitWhip)
	mux.HandleFunc("DELETE /api/livekit/whip/{id}", a.sessDelete("api/livekit/whip"))
	if livekitURL != "" {
		target, err := url.Parse(livekitURL)
		if err != nil {
			log.Fatal(err)
		}
		mux.Handle("/livekit/", http.StripPrefix("/livekit", httputil.NewSingleHostReverseProxy(target)))
	}
	mux.HandleFunc("POST /api/whip", a.whipPost)
	mux.HandleFunc("DELETE /api/whip/{id}", a.sessDelete("api/whip"))
	mux.HandleFunc("POST /api/whep", a.whepPost)
	mux.HandleFunc("DELETE /api/whep/{id}", a.sessDelete("api/whep"))

	// lives fixas: mesmo reverse proxy do fixed-proxy.patch (WS incluído —
	// o httputil cuida do upgrade)
	if fixedURL != "" {
		target, err := url.Parse(fixedURL)
		if err != nil {
			log.Fatalf("FIXED_LIVE_URL inválida: %v", err)
		}
		mux.Handle("/api/fixed/", httputil.NewSingleHostReverseProxy(target))
	}

	// estáticos da ui/ e o instalador do app (mesma cara do web/build do
	// broadcast-box; sem Cache-Control — Cloudflare cacheia assets por 4h)
	mux.Handle("/download/", http.StripPrefix("/download/", http.FileServer(http.Dir(dlDir))))
	mux.Handle("/", http.FileServer(http.Dir(staticDir)))

	log.Printf("[live-api] listen %s (mediamtx %s, fixed %s)", listen, mtxWebRTC, fixedURL)
	log.Fatal(http.ListenAndServe(listen, cors(mux)))
}
