package main

// API gateway: routing, JWT verification, rate limiting, CORS, metrics.
// Verified identity is forwarded to services as X-User-* headers; any
// client-supplied X-User-* header is stripped first.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type claims struct {
	Sub   string `json:"sub"`
	Role  string `json:"role"`
	Email string `json:"email"`
	Exp   int64  `json:"exp"`
}

func verifyJWT(token, secret string) (*claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("malformed token")
	}
	hdrRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, errors.New("bad header")
	}
	var hdr struct {
		Alg string `json:"alg"`
	}
	if json.Unmarshal(hdrRaw, &hdr) != nil || hdr.Alg != "HS256" {
		return nil, errors.New("unsupported alg")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return nil, errors.New("bad signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errors.New("bad payload")
	}
	var c claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, errors.New("bad claims")
	}
	if c.Sub == "" || (c.Exp != 0 && time.Now().Unix() > c.Exp) {
		return nil, errors.New("expired or invalid")
	}
	return &c, nil
}

type upstream struct {
	name  string
	proxy *httputil.ReverseProxy
}

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func newUpstream(name, raw string) *upstream {
	target, err := url.Parse(raw)
	if err != nil {
		log.Fatalf("bad upstream url for %s: %v", name, err)
	}
	p := httputil.NewSingleHostReverseProxy(target)
	p.Transport = &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:          200,
		MaxIdleConnsPerHost:   100,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
	}
	p.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("upstream %s error: %v", name, err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream unavailable: " + name})
	}
	return &upstream{name: name, proxy: p}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// fixed-window per-IP rate limiter
type limiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string]*struct {
		n     int
		reset time.Time
	}
}

func newLimiter(limit int, window time.Duration) *limiter {
	l := &limiter{limit: limit, window: window, hits: map[string]*struct {
		n     int
		reset time.Time
	}{}}
	go func() {
		for range time.Tick(time.Minute) {
			l.mu.Lock()
			now := time.Now()
			for k, v := range l.hits {
				if now.After(v.reset) {
					delete(l.hits, k)
				}
			}
			l.mu.Unlock()
		}
	}()
	return l
}

func (l *limiter) allow(ip string) bool {
	if l.limit <= 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	e, ok := l.hits[ip]
	if !ok || now.After(e.reset) {
		e = &struct {
			n     int
			reset time.Time
		}{reset: now.Add(l.window)}
		l.hits[ip] = e
	}
	e.n++
	return e.n <= l.limit
}

func clientIP(r *http.Request) string {
	if xf := r.Header.Get("X-Forwarded-For"); xf != "" {
		return strings.TrimSpace(strings.Split(xf, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func isPublic(svc, method, path string) bool {
	switch svc {
	case "users":
		return method == http.MethodPost && (path == "/users/register" || path == "/users/login")
	case "products":
		return method == http.MethodGet || method == http.MethodHead
	}
	return false
}

func serviceOf(path string) string {
	p := strings.TrimPrefix(path, "/api/")
	if i := strings.IndexByte(p, '/'); i >= 0 {
		p = p[:i]
	}
	return p
}

func main() {
	secret := os.Getenv("JWT_SECRET")
	if len(secret) < 32 {
    	     log.Fatal("JWT_SECRET must be configured with at least 32 characters")
	}
	limit, _ := strconv.Atoi(getenv("RATE_LIMIT_PER_MIN", "600"))
	reg := newRegistry("gateway")
	lim := newLimiter(limit, time.Minute)

	ups := map[string]*upstream{
		"users":    newUpstream("user-service", getenv("USER_SERVICE_URL", "http://user-service:3001")),
		"products": newUpstream("catalog-service", getenv("CATALOG_SERVICE_URL", "http://catalog-service:3002")),
		"cart":     newUpstream("cart-service", getenv("CART_SERVICE_URL", "http://cart-service:3003")),
		"orders":   newUpstream("order-service", getenv("ORDER_SERVICE_URL", "http://order-service:3004")),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})
	mux.Handle("/metrics", reg.handler())
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		svc := serviceOf(r.URL.Path)
		up, ok := ups[svc]
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown route"})
			return
		}
		if !lim.allow(clientIP(r)) {
			w.Header().Set("Retry-After", "60")
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limit exceeded"})
			return
		}

		// never trust client-supplied identity headers
		for _, h := range []string{"X-User-Id", "X-User-Role", "X-User-Email"} {
			r.Header.Del(h)
		}
		path := strings.TrimPrefix(r.URL.Path, "/api")
		if tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "); tok != "" && tok != r.Header.Get("Authorization") {
			if c, err := verifyJWT(tok, secret); err == nil {
				r.Header.Set("X-User-Id", c.Sub)
				r.Header.Set("X-User-Role", c.Role)
				r.Header.Set("X-User-Email", c.Email)
			}
		}
		if r.Header.Get("X-User-Id") == "" && !isPublic(svc, r.Method, path) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
			return
		}

		r2 := r.Clone(r.Context())
		r2.URL.Path = path
		r2.URL.RawPath = ""
		up.proxy.ServeHTTP(w, r2)
	})

	routeOf := func(r *http.Request) string {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/"):
			if s := serviceOf(r.URL.Path); ups[s] != nil {
				return s
			}
			return "unknown"
		case r.URL.Path == "/healthz" || r.URL.Path == "/metrics":
			return r.URL.Path
		}
		return "unknown"
	}

	handler := cors(reg.instrument(routeOf, mux))
	srv := &http.Server{
		Addr:              ":" + getenv("PORT", "8080"),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("gateway listening on %s", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func cors(next http.Handler) http.Handler {
	origin := getenv("CORS_ORIGIN", "*")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
