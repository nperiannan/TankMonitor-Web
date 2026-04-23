package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/gorilla/websocket"
)

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const webVersion = "1.3.0"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Schedule struct {
	I  int    `json:"i"`
	M  string `json:"m"`
	T  string `json:"t"`
	D  uint16 `json:"d"`
	On bool   `json:"on"`
}

type Status struct {
	OHState     string     `json:"oh_state"`
	UGState     string     `json:"ug_state"`
	OHMotor     bool       `json:"oh_motor"`
	UGMotor     bool       `json:"ug_motor"`
	LoraOK      bool       `json:"lora_ok"`
	WiFiRSSI    int        `json:"wifi_rssi"`
	UptimeS     uint64     `json:"uptime_s"`
	FW          string     `json:"fw"`
	Time        string     `json:"time"`
	Schedules   []Schedule `json:"schedules"`
	OHDispOnly  bool       `json:"oh_disp_only"`
	UGDispOnly  bool       `json:"ug_disp_only"`
	UGIgnore    bool       `json:"ug_ignore"`
	BuzzerDelay bool       `json:"buzzer_delay"`
	LcdBlMode   uint8      `json:"lcd_bl_mode"`
}

// ---------------------------------------------------------------------------
// OTA state
// ---------------------------------------------------------------------------

type OtaInfo struct {
	HasFirmware bool   `json:"has_firmware"`
	Filename    string `json:"filename"`
	Size        int64  `json:"size"`
	UploadedAt  string `json:"uploaded_at"`
	Phase       string `json:"phase"`       // idle | triggered | downloading | success | failed
	PrevFw      string `json:"prev_fw,omitempty"`
}

var (
	otaMu   sync.RWMutex
	otaInfo OtaInfo
)

const otaDir = "/tmp/ota"
const otaFile = "/tmp/ota/firmware.bin"

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

var (
	stateMu    sync.RWMutex
	lastStatus []byte // raw JSON, kept for fast broadcast

	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}
	clientsMu sync.Mutex
	clients   = make(map[*websocket.Conn]struct{})
	broadcast = make(chan []byte, 64)

	mqttCli mqtt.Client

	// allowedCmds is the whitelist for inbound control requests.
	allowedCmds = map[string]bool{
		"oh_on": true, "oh_off": true,
		"ug_on": true, "ug_off": true,
		"sched_add": true, "sched_remove": true, "sched_clear": true,
		"set_setting": true, "sync_ntp": true, "reboot": true,
		"set_lcd_mode": true, "get_logs": true,
		"ota_start": true, "ota_rollback": true,
	}

	authSecret []byte
)

// ---------------------------------------------------------------------------
// Auth — stateless HMAC-SHA256 signed tokens (no external dependency)
// Token format: base64url(user:expiry) + "." + base64url(hmac-sha256)
// ---------------------------------------------------------------------------

func init() {
	secret := env("AUTH_SECRET", "")
	if secret != "" {
		authSecret = []byte(secret)
	} else {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			panic(err)
		}
		authSecret = b
		log.Println("[AUTH] No AUTH_SECRET set — generated ephemeral secret (tokens invalidated on restart)")
	}
}

// tokenMake returns a signed token valid for 30 days.
func tokenMake(user string) string {
	expiry := strconv.FormatInt(time.Now().Add(30*24*time.Hour).Unix(), 10)
	payload := base64.RawURLEncoding.EncodeToString([]byte(user + ":" + expiry))
	mac := hmac.New(sha256.New, authSecret)
	mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return payload + "." + sig
}

// tokenVerify returns (username, true) if the token is valid and not expired.
func tokenVerify(token string) (string, bool) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return "", false
	}
	payload, sig := parts[0], parts[1]
	mac := hmac.New(sha256.New, authSecret)
	mac.Write([]byte(payload))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(sig), []byte(expected)) {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return "", false
	}
	idx := strings.LastIndex(string(raw), ":")
	if idx < 0 {
		return "", false
	}
	expiry, err := strconv.ParseInt(string(raw[idx+1:]), 10, 64)
	if err != nil || time.Now().Unix() > expiry {
		return "", false
	}
	return string(raw[:idx]), true
}

func extractToken(r *http.Request) string {
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	return r.URL.Query().Get("token")
}

func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			cors(w)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if _, ok := tokenVerify(extractToken(r)); !ok {
			cors(w)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error":"unauthorized"}`)) //nolint:errcheck
			return
		}
		next(w, r)
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func controlTopic() string {
	return fmt.Sprintf("tankmonitor/%s/control", env("MQTT_LOCATION", "home"))
}

// ---------------------------------------------------------------------------
// MQTT
// ---------------------------------------------------------------------------

func startMQTT() {
	broker := env("MQTT_BROKER", "localhost")
	port := env("MQTT_PORT", "1883")
	user := env("MQTT_USER", "tankmonitor")
	pass := env("MQTT_PASS", "###TankMonitor12345")
	location := env("MQTT_LOCATION", "home")

	statusT := fmt.Sprintf("tankmonitor/%s/status", location)
	logsT   := fmt.Sprintf("tankmonitor/%s/logs",   location)

	opts := mqtt.NewClientOptions().
		AddBroker(fmt.Sprintf("tcp://%s:%s", broker, port)).
		SetClientID("tankmonitor-web").
		SetUsername(user).
		SetPassword(pass).
		SetKeepAlive(60 * time.Second).
		SetAutoReconnect(true).
		SetOnConnectHandler(func(c mqtt.Client) {
			log.Printf("[MQTT] Connected — subscribing %s %s", statusT, logsT)
			c.Subscribe(statusT, 1, onStatusMsg)
			c.Subscribe(logsT,   0, onLogsMsg)
		}).
		SetConnectionLostHandler(func(_ mqtt.Client, err error) {
			log.Printf("[MQTT] Connection lost: %v", err)
		})

	mqttCli = mqtt.NewClient(opts)
	for {
		if tok := mqttCli.Connect(); tok.Wait() && tok.Error() == nil {
			break
		}
		log.Println("[MQTT] Connect failed — retrying in 5s…")
		time.Sleep(5 * time.Second)
	}
}

func onStatusMsg(_ mqtt.Client, msg mqtt.Message) {
	raw := make([]byte, len(msg.Payload()))
	copy(raw, msg.Payload())

	stateMu.Lock()
	lastStatus = raw
	stateMu.Unlock()

	// Detect OTA success: fw version changed after trigger
	otaMu.Lock()
	if otaInfo.Phase == "triggered" || otaInfo.Phase == "downloading" {
		var st Status
		if err := json.Unmarshal(raw, &st); err == nil && st.FW != "" && st.FW != otaInfo.PrevFw {
			otaInfo.Phase = "success"
			log.Printf("[OTA] Success — fw changed %s → %s", otaInfo.PrevFw, st.FW)
		}
	}
	otaMu.Unlock()

	select {
	case broadcast <- raw:
	default: // drop if hub is backed up
	}
}

func publishControl(body []byte) error {
	if mqttCli == nil || !mqttCli.IsConnected() {
		return fmt.Errorf("MQTT not connected")
	}
	tok := mqttCli.Publish(controlTopic(), 1, false, body)
	tok.Wait()
	return tok.Error()
}

// ---------------------------------------------------------------------------
// WebSocket hub — fans out status updates to all connected browsers
// ---------------------------------------------------------------------------

func hub() {
	for msg := range broadcast {
		clientsMu.Lock()
		for conn := range clients {
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				conn.Close()
				delete(clients, conn)
			}
		}
		clientsMu.Unlock()
	}
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

func cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var creds struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&creds); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	wantUser := env("AUTH_USER", "admin")
	wantPass := env("AUTH_PASS", "tank1234")
	// Constant-time comparison to prevent timing attacks
	userOK := hmac.Equal([]byte(creds.Username), []byte(wantUser))
	passOK := hmac.Equal([]byte(creds.Password), []byte(wantPass))
	if !userOK || !passOK {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":"invalid credentials"}`)) //nolint:errcheck
		return
	}
	token := tokenMake(creds.Username)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": token}) //nolint:errcheck
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WS] Upgrade error: %v", err)
		return
	}

	clientsMu.Lock()
	clients[conn] = struct{}{}
	clientsMu.Unlock()

	// Push current status immediately on connect.
	stateMu.RLock()
	cur := lastStatus
	stateMu.RUnlock()
	if cur != nil {
		conn.WriteMessage(websocket.TextMessage, cur) //nolint:errcheck
	}

	// Read loop — detects disconnect.
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			clientsMu.Lock()
			delete(clients, conn)
			clientsMu.Unlock()
			conn.Close()
			return
		}
	}
}

func handleVersion(w http.ResponseWriter, r *http.Request) {
	cors(w)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"web_version": webVersion}) //nolint:errcheck
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	cors(w)
	w.Header().Set("Content-Type", "application/json")
	stateMu.RLock()
	cur := lastStatus
	stateMu.RUnlock()
	if cur == nil {
		w.Write([]byte(`{}`)) //nolint:errcheck
		return
	}
	w.Write(cur) //nolint:errcheck
}

func handleControl(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	cmd, _ := body["cmd"].(string)
	if !allowedCmds[cmd] {
		http.Error(w, "unknown command", http.StatusBadRequest)
		return
	}

	raw, _ := json.Marshal(body)
	if err := publishControl(raw); err != nil {
		http.Error(w, "MQTT error: "+err.Error(), http.StatusServiceUnavailable)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`)) //nolint:errcheck
}

// ---------------------------------------------------------------------------
// OTA handlers
// ---------------------------------------------------------------------------

func handleOtaStatus(w http.ResponseWriter, r *http.Request) {
	cors(w)
	otaMu.RLock()
	info := otaInfo
	otaMu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(info) //nolint:errcheck
}

func handleOtaUpload(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// 64 MB limit
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		http.Error(w, "file too large or invalid form", http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("firmware")
	if err != nil {
		http.Error(w, "missing firmware field", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Validate extension
	if !strings.HasSuffix(strings.ToLower(header.Filename), ".bin") {
		http.Error(w, "only .bin files accepted", http.StatusBadRequest)
		return
	}

	if err := os.MkdirAll(otaDir, 0755); err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	dest, err := os.Create(otaFile)
	if err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	defer dest.Close()
	written, err := io.Copy(dest, file)
	if err != nil {
		http.Error(w, "write error", http.StatusInternalServerError)
		return
	}

	otaMu.Lock()
	otaInfo = OtaInfo{
		HasFirmware: true,
		Filename:    filepath.Base(header.Filename),
		Size:        written,
		UploadedAt:  time.Now().UTC().Format(time.RFC3339),
		Phase:       "idle",
	}
	otaMu.Unlock()

	log.Printf("[OTA] Firmware uploaded: %s (%d bytes)", header.Filename, written)
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`)) //nolint:errcheck
}

func handleOtaTrigger(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	otaMu.RLock()
	has := otaInfo.HasFirmware
	otaMu.RUnlock()
	if !has {
		http.Error(w, "no firmware staged", http.StatusBadRequest)
		return
	}
	// Build the URL the ESP32 should fetch from
	// Use X-Forwarded-Host or Host header so it works behind any proxy
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	scheme := "http"
	if r.Header.Get("X-Forwarded-Proto") == "https" || r.TLS != nil {
		scheme = "https"
	}
	firmwareURL := fmt.Sprintf("%s://%s/api/ota/firmware.bin", scheme, host)

	payload, _ := json.Marshal(map[string]interface{}{
		"cmd": "ota_start",
		"url": firmwareURL,
	})
	if err := publishControl(payload); err != nil {
		http.Error(w, "MQTT error: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	log.Printf("[OTA] Triggered flash — URL: %s", firmwareURL)

	// Record phase transition and start failure-timeout goroutine
	stateMu.RLock()
	var curSt Status
	_ = json.Unmarshal(lastStatus, &curSt)
	stateMu.RUnlock()

	otaMu.Lock()
	otaInfo.Phase  = "triggered"
	otaInfo.PrevFw = curSt.FW
	otaMu.Unlock()

	// Auto-fail if no version change seen within 120 s
	go func() {
		time.Sleep(120 * time.Second)
		otaMu.Lock()
		if otaInfo.Phase == "triggered" || otaInfo.Phase == "downloading" {
			otaInfo.Phase = "failed"
			log.Printf("[OTA] Timeout — marking as failed")
		}
		otaMu.Unlock()
	}()

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`)) //nolint:errcheck
}

func handleOtaRollback(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	payload, _ := json.Marshal(map[string]string{"cmd": "ota_rollback"})
	if err := publishControl(payload); err != nil {
		http.Error(w, "MQTT error: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	log.Printf("[OTA] Rollback triggered")
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`)) //nolint:errcheck
}

func handleOtaServeFirmware(w http.ResponseWriter, r *http.Request) {
	// No auth here intentionally — ESP32 fetches this without token support
	otaMu.RLock()
	has := otaInfo.HasFirmware
	filename := otaInfo.Filename
	otaMu.RUnlock()
	if !has {
		http.Error(w, "no firmware", http.StatusNotFound)
		return
	}
	log.Printf("[OTA] Serving firmware to %s", r.RemoteAddr)
	otaMu.Lock()
	if otaInfo.Phase == "triggered" {
		otaInfo.Phase = "downloading"
	}
	otaMu.Unlock()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	http.ServeFile(w, r, otaFile)
}

// ---------------------------------------------------------------------------
// Device logs cache (populated by MQTT subscription to logs topic)
// ---------------------------------------------------------------------------

var (
	logsMu     sync.RWMutex
	lastLogs   []byte // raw JSON blob from ESP32 {"logs":[...]}
	logsSeenAt time.Time
)

func logsTopic() string {
	return fmt.Sprintf("tankmonitor/%s/logs", env("MQTT_LOCATION", "home"))
}

func onLogsMsg(_ mqtt.Client, msg mqtt.Message) {
	raw := make([]byte, len(msg.Payload()))
	copy(raw, msg.Payload())
	logsMu.Lock()
	lastLogs = raw
	logsSeenAt = time.Now()
	logsMu.Unlock()
}

func handleLogs(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	logsMu.RLock()
	blob := lastLogs
	seen := logsSeenAt
	logsMu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	if len(blob) == 0 {
		w.Write([]byte(`{"logs":[],"note":"No logs received yet"}`)) //nolint:errcheck
		return
	}
	// Inject a received_at field
	trimmed := strings.TrimSuffix(strings.TrimSpace(string(blob)), "}")
	out := trimmed + fmt.Sprintf(`,"received_at":"%s"}`, seen.UTC().Format(time.RFC3339))
	w.Write([]byte(out)) //nolint:errcheck
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	go startMQTT()
	go hub()

	port := env("PORT", "8080")
	staticDir := env("STATIC_DIR", "/app/static")

	mux := http.NewServeMux()
	mux.HandleFunc("/api/login", handleLogin)
	mux.HandleFunc("/api/version", requireAuth(handleVersion))
	mux.HandleFunc("/api/status", requireAuth(handleStatus))
	mux.HandleFunc("/api/control", requireAuth(handleControl))
	mux.HandleFunc("/ws", requireAuth(handleWS))
	// OTA endpoints
	mux.HandleFunc("/api/ota/status", requireAuth(handleOtaStatus))
	mux.HandleFunc("/api/ota/upload", requireAuth(handleOtaUpload))
	mux.HandleFunc("/api/ota/trigger", requireAuth(handleOtaTrigger))
	mux.HandleFunc("/api/ota/rollback", requireAuth(handleOtaRollback))
	mux.HandleFunc("/api/ota/firmware.bin", handleOtaServeFirmware)	// Device logs
	mux.HandleFunc("/api/logs",            requireAuth(handleLogs))
	// Serve the React SPA — fall back to index.html for unknown paths.
	fs := http.FileServer(http.Dir(staticDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fullPath := filepath.Join(staticDir, filepath.Clean("/"+r.URL.Path))
		if _, err := os.Stat(fullPath); os.IsNotExist(err) {
			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
			return
		}
		fs.ServeHTTP(w, r)
	})

	log.Printf("[HTTP] Listening on :%s  static=%s", port, staticDir)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}
