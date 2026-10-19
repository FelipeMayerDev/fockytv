package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
		w.WriteHeader(200)
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
