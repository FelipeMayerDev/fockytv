package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLivekitAnnounceOnceInTheLiveVoiceChannel(t *testing.T) {
	type post struct {
		channel string
		payload map[string]any
		image   []byte
	}
	var posts []post
	fail := false
	channels := map[string]string{ // id → resposta do GET /channels/{id}
		"111111111111111111": `{"guild_id":"999999999999999999","type":2}`,
		"222222222222222222": `{"guild_id":"999999999999999999","type":0}`,
		"333333333333333333": `{"guild_id":"888888888888888888","type":2}`,
	}
	discord := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bot token" {
			t.Errorf("missing bot auth on %s", r.URL.Path)
		}
		id := strings.Split(strings.TrimPrefix(r.URL.Path, "/channels/"), "/")[0]
		if r.Method == "GET" {
			if body, ok := channels[id]; ok {
				w.Write([]byte(body))
			} else {
				w.WriteHeader(404)
			}
			return
		}
		if fail {
			w.WriteHeader(500)
			return
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Fatal(err)
		}
		p := post{channel: id}
		json.Unmarshal([]byte(r.FormValue("payload_json")), &p.payload)
		if file, _, err := r.FormFile("files[0]"); err == nil {
			p.image, _ = io.ReadAll(file)
		}
		posts = append(posts, p)
		w.Write([]byte(`{"id":"555555555555555555"}`))
	}))
	defer discord.Close()
	oldAPI, oldToken, oldGuild := discordAPI, discordToken, discordGuild
	defer func() { discordAPI, discordToken, discordGuild = oldAPI, oldToken, oldGuild }()
	discordAPI, discordToken, discordGuild = discord.URL, "token", "999999999999999999"

	a := newApp()
	a.sessions["sid"] = &session{kind: "livekit-whip", path: "ana", nick: "ana", id: "sid"}
	jpeg := base64.StdEncoding.EncodeToString([]byte{0xff, 0xd8, 0xff, 0xe0, 1, 2, 3})
	body := func(channel string) string {
		return `{"channel":"` + channel + `","title":"@everyone Ranked","detail":"🎮 Valorant","thumbnail":"` + jpeg + `"}`
	}
	send := func(id, who, body string) int {
		r := httptest.NewRequest("POST", "/api/livekit/whip/"+id+"/announce", strings.NewReader(body))
		r.SetPathValue("id", id)
		r.Header.Set("Authorization", "Bearer "+who)
		w := httptest.NewRecorder()
		a.livekitAnnounce(w, r)
		return w.Code
	}
	valid := body("111111111111111111")
	for _, c := range []struct {
		name, id, who, body string
		code                int
	}{
		{"unknown session", "missing", "ana", valid, 404},
		{"not the owner", "sid", "bob", valid, 400},
		{"empty title", "sid", "ana", `{"channel":"111111111111111111","title":"  ","thumbnail":""}`, 400},
		{"not a JPEG", "sid", "ana", `{"channel":"111111111111111111","title":"x","thumbnail":"` + base64.StdEncoding.EncodeToString([]byte("<svg>")) + `"}`, 400},
		{"channel path injection", "sid", "ana", body("1/../../guilds/1"), 400},
		{"text channel", "sid", "ana", body("222222222222222222"), 403},
		{"other server", "sid", "ana", body("333333333333333333"), 403},
		{"unknown channel", "sid", "ana", body("444444444444444444"), 403},
	} {
		if code := send(c.id, c.who, c.body); code != c.code {
			t.Fatalf("%s: got %d, want %d", c.name, code, c.code)
		}
	}
	fail = true
	if code := send("sid", "ana", valid); code != 502 {
		t.Fatalf("failed post: got %d", code)
	}
	fail = false
	if code := send("sid", "ana", valid); code != 204 {
		t.Fatalf("retry after failure: got %d", code)
	}
	if code := send("sid", "ana", valid); code != 204 || len(posts) != 1 {
		t.Fatalf("second announce must not post again: got %d, %d posts", code, len(posts))
	}
	embed := posts[0].payload["embeds"].([]any)[0].(map[string]any)
	mentions := posts[0].payload["allowed_mentions"].(map[string]any)["parse"].([]any)
	if posts[0].channel != "111111111111111111" || embed["title"] != "@everyone Ranked" || embed["description"] != "🎮 Valorant" || len(mentions) != 0 ||
		embed["image"].(map[string]any)["url"] != "attachment://live.jpg" || len(posts[0].image) != 7 {
		t.Fatal(posts[0])
	}
}

func TestLiveAnnouncementFollowsSessionLifecycle(t *testing.T) {
	oldAPI, oldToken, oldGuild, oldLivekit := discordAPI, discordToken, discordGuild, livekitURL
	t.Cleanup(func() { discordAPI, discordToken, discordGuild, livekitURL = oldAPI, oldToken, oldGuild, oldLivekit })
	deleted := make(chan string, 10)
	postStarted, finishPost := make(chan struct{}), make(chan struct{})
	var blockPost, live, failLivekit atomic.Bool
	live.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/ListRooms"):
			if failLivekit.Load() {
				w.WriteHeader(503)
				return
			}
			w.Write([]byte(`{"rooms":[{"name":"ana"}]}`))
		case strings.HasSuffix(r.URL.Path, "/ListParticipants"):
			if live.Load() {
				w.Write([]byte(`{"participants":[{"identity":"publisher","tracks":[{"type":"VIDEO"}]}]}`))
			} else {
				w.Write([]byte(`{"participants":[]}`))
			}
		case r.URL.Path == "/ingress/session":
			w.WriteHeader(204)
		case r.Method == "GET":
			w.Write([]byte(`{"guild_id":"999999999999999999","type":2}`))
		case r.Method == "POST":
			if blockPost.Load() {
				close(postStarted)
				<-finishPost
			}
			w.Write([]byte(`{"id":"555555555555555555"}`))
		case r.Method == "DELETE":
			if r.Header.Get("Authorization") != "Bot token" {
				t.Error("missing bot authentication")
			}
			deleted <- r.URL.Path
			w.WriteHeader(204)
		}
	}))
	defer server.Close()
	discordAPI, discordToken, discordGuild, livekitURL = server.URL, "token", "999999999999999999", server.URL
	newSession := func() (*app, *session) {
		a := newApp()
		s := &session{kind: "livekit-whip", path: "ana", nick: "ana", id: "sid", location: server.URL + "/ingress/session", createdAt: time.Now().Add(-time.Minute)}
		a.sessions[s.id] = s
		return a, s
	}
	announce := func(a *app) {
		r := httptest.NewRequest("POST", "/announce", strings.NewReader(`{"channel":"111111111111111111","title":"Live","thumbnail":""}`))
		r.SetPathValue("id", "sid")
		r.Header.Set("Authorization", "Bearer ana")
		w := httptest.NewRecorder()
		a.livekitAnnounce(w, r)
		if w.Code != 204 {
			t.Errorf("announce status %d: %s", w.Code, w.Body.String())
		}
	}
	waitDeleted := func() {
		t.Helper()
		select {
		case path := <-deleted:
			if path != "/channels/111111111111111111/messages/555555555555555555" {
				t.Fatal(path)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("announcement was not deleted")
		}
	}
	a, s := newSession()
	announce(a)
	if s.announceMessage != "555555555555555555" {
		t.Fatal("message id was not saved")
	}
	closeSession := func(who string) int {
		r := httptest.NewRequest("DELETE", "/session", nil)
		r.SetPathValue("id", "sid")
		r.Header.Set("Authorization", "Bearer "+who)
		w := httptest.NewRecorder()
		a.sessDelete("api/livekit/whip")(w, r)
		return w.Code
	}
	if closeSession("other") != 400 || s.announceMessage == "" {
		t.Fatal("another user deleted the announcement")
	}
	if closeSession("ana") != 204 {
		t.Fatal("could not end session")
	}
	waitDeleted()

	a, s = newSession()
	announce(a)
	a.pollAnnouncements()
	if a.sessions[s.id] != s {
		t.Fatal("active live was removed")
	}
	live.Store(false)
	failLivekit.Store(true)
	a.pollAnnouncements()
	if a.sessions[s.id] != s {
		t.Fatal("LiveKit outage removed live")
	}
	failLivekit.Store(false)
	s.createdAt = time.Now()
	a.pollAnnouncements()
	if a.sessions[s.id] != s {
		t.Fatal("starting live was removed")
	}
	s.createdAt = time.Now().Add(-time.Minute)
	a.pollAnnouncements()
	waitDeleted()

	a, s = newSession()
	blockPost.Store(true)
	done := make(chan struct{})
	go func() { announce(a); close(done) }()
	<-postStarted
	a.mu.Lock()
	a.drop(s)
	a.mu.Unlock()
	close(finishPost)
	<-done
	waitDeleted()
}

func TestDeleteAnnouncementAlreadyGone(t *testing.T) {
	old := discordAPI
	defer func() { discordAPI = old }()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(404)
	}))
	defer server.Close()
	discordAPI = server.URL
	deleteAnnounce("111111111111111111", "555555555555555555")
	if calls != 1 {
		t.Fatalf("deleted message was retried %d times", calls)
	}
}

func TestDeleteAnnouncementRetriesTransientFailure(t *testing.T) {
	old := discordAPI
	defer func() { discordAPI = old }()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(502)
		} else {
			w.WriteHeader(204)
		}
	}))
	defer server.Close()
	discordAPI = server.URL
	deleteAnnounce("111111111111111111", "555555555555555555")
	if calls != 2 {
		t.Fatalf("expected retry after 502, got %d attempts", calls)
	}
}
