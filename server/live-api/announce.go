package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// Bot do Discord que avisa no chat do canal de voz da live; sem token ou servidor o aviso fica desligado.
// Só canais de voz do servidor (guild) configurado: o plugin escolhe o canal, não qualquer canal que o bot vê.
var discordToken = env("FOCKYTV_DISCORD_TOKEN", "")
var discordGuild = env("FOCKYTV_DISCORD_GUILD", "")
var discordAPI = "https://discord.com/api/v10"
var snowflakeRe = regexp.MustCompile(`^\d{15,25}$`)

// Canal de voz da live, título, jogo/janela e miniatura (JPEG em base64) que o plugin manda quando a live começa.
type liveAnnounce struct {
	Channel   string `json:"channel"`
	Title     string `json:"title"`
	Detail    string `json:"detail"`
	Thumbnail string `json:"thumbnail"`
}

func (l liveAnnounce) image() ([]byte, bool) {
	title, detail := strings.TrimSpace(l.Title), strings.TrimSpace(l.Detail)
	if !snowflakeRe.MatchString(l.Channel) || title == "" || utf8.RuneCountInString(title) > 100 || utf8.RuneCountInString(detail) > 100 {
		return nil, false
	}
	image, err := base64.StdEncoding.DecodeString(l.Thumbnail)
	if err != nil || len(image) > 400*1024 || (len(image) > 0 && !bytes.HasPrefix(image, []byte{0xff, 0xd8})) {
		return nil, false
	}
	return image, true
}

// Só o dono da sessão WHIP (id secreto + bearer da live) avisa, e uma vez por sessão.
func (a *app) livekitAnnounce(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	s := a.sessions[r.PathValue("id")]
	a.mu.Unlock()
	if s == nil || s.kind != "livekit-whip" {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	if bearer(r) != s.nick {
		http.Error(w, "Authorization was not set", http.StatusBadRequest)
		return
	}
	var announce liveAnnounce
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 600*1024)).Decode(&announce); err != nil {
		http.Error(w, "Aviso inválido", 400)
		return
	}
	image, ok := announce.image()
	if !ok {
		http.Error(w, "Aviso inválido", 400)
		return
	}
	if discordToken == "" || discordGuild == "" {
		w.WriteHeader(204)
		return
	}
	a.mu.Lock()
	first := !s.announced
	s.announced = true
	a.mu.Unlock()
	if !first {
		w.WriteHeader(204)
		return
	}
	retry := func(code int, message string) {
		a.mu.Lock()
		s.announced = false // deixa o plugin tentar de novo
		a.mu.Unlock()
		http.Error(w, message, code)
	}
	if allowed, err := voiceChannel(r, announce.Channel); err != nil {
		retry(502, "Discord indisponível")
		return
	} else if !allowed {
		retry(403, "Canal não permitido")
		return
	}
	if err := postAnnounce(r, s.path, announce, image); err != nil {
		retry(502, "Discord indisponível")
		return
	}
	w.WriteHeader(204)
}

func discordRequest(r *http.Request, method, path string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(r.Context(), method, discordAPI+path, body)
	if err == nil {
		req.Header.Set("Authorization", "Bot "+discordToken)
	}
	return req, err
}

// Canal de voz ou palco do servidor configurado.
func voiceChannel(r *http.Request, id string) (bool, error) {
	req, err := discordRequest(r, "GET", "/channels/"+id, nil)
	if err != nil {
		return false, err
	}
	res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return false, err
	}
	defer res.Body.Close()
	if res.StatusCode == 403 || res.StatusCode == 404 {
		return false, nil
	}
	if res.StatusCode >= 300 {
		return false, fmt.Errorf("discord HTTP %d", res.StatusCode)
	}
	var channel struct {
		GuildID string `json:"guild_id"`
		Type    int    `json:"type"`
	}
	if err := json.NewDecoder(res.Body).Decode(&channel); err != nil {
		return false, err
	}
	return channel.GuildID == discordGuild && (channel.Type == 2 || channel.Type == 13), nil
}

func postAnnounce(r *http.Request, nick string, announce liveAnnounce, image []byte) error {
	embed := map[string]any{
		"title":     strings.TrimSpace(announce.Title),
		"color":     0x5865f2,
		"author":    map[string]string{"name": nick + " está ao vivo no FockyTV"},
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	}
	if detail := strings.TrimSpace(announce.Detail); detail != "" {
		embed["description"] = detail
	}
	if len(image) > 0 {
		embed["image"] = map[string]string{"url": "attachment://live.jpg"}
	}
	// Sem menções: um título com @everyone não pinga ninguém.
	payload, _ := json.Marshal(map[string]any{"allowed_mentions": map[string]any{"parse": []string{}}, "embeds": []any{embed}})
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	form.WriteField("payload_json", string(payload))
	if len(image) > 0 {
		part, _ := form.CreatePart(textproto.MIMEHeader{
			"Content-Disposition": {`form-data; name="files[0]"; filename="live.jpg"`},
			"Content-Type":        {"image/jpeg"},
		})
		part.Write(image)
	}
	form.Close()
	req, err := discordRequest(r, "POST", "/channels/"+announce.Channel+"/messages", &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("discord HTTP %d", res.StatusCode)
	}
	return nil
}
