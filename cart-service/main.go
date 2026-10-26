package main

// Cart service: per-user shopping cart stored in a Redis hash (cart:<userId>).
// Prices/names are always taken from the catalog service, never from the client.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"syscall"
	"time"
)

type CartItem struct {
	ProductID string  `json:"productId"`
	Name      string  `json:"name"`
	Price     float64 `json:"price"`
	Image     string  `json:"image,omitempty"`
	Qty       int     `json:"qty"`
}

type Cart struct {
	Items []CartItem `json:"items"`
	Count int        `json:"count"`
	Total float64    `json:"total"`
}

type server struct {
	rdb        *redisClient
	catalogURL string
	httpc      *http.Client
	ttl        int
	reg        *registry
}

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func cartKey(uid string) string { return "cart:" + uid }

func (s *server) load(uid string) (Cart, error) {
	res, err := s.rdb.Do("HGETALL", cartKey(uid))
	if err != nil {
		return Cart{}, err
	}
	cart := Cart{Items: []CartItem{}}
	arr, _ := res.([]any)
	for i := 0; i+1 < len(arr); i += 2 {
		raw, _ := arr[i+1].(string)
		var it CartItem
		if json.Unmarshal([]byte(raw), &it) == nil {
			cart.Items = append(cart.Items, it)
		}
	}
	sort.Slice(cart.Items, func(i, j int) bool { return cart.Items[i].Name < cart.Items[j].Name })
	for _, it := range cart.Items {
		cart.Count += it.Qty
		cart.Total += it.Price * float64(it.Qty)
	}
	cart.Total = math.Round(cart.Total*100) / 100
	return cart, nil
}

func (s *server) save(uid string, it CartItem) error {
	b, _ := json.Marshal(it)
	if _, err := s.rdb.Do("HSET", cartKey(uid), it.ProductID, string(b)); err != nil {
		return err
	}
	_, err := s.rdb.Do("EXPIRE", cartKey(uid), strconv.Itoa(s.ttl))
	return err
}

func (s *server) existing(uid, pid string) (*CartItem, error) {
	res, err := s.rdb.Do("HGET", cartKey(uid), pid)
	if err != nil {
		return nil, err
	}
	raw, ok := res.(string)
	if !ok {
		return nil, nil
	}
	var it CartItem
	if err := json.Unmarshal([]byte(raw), &it); err != nil {
		return nil, err
	}
	return &it, nil
}

type product struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Price float64 `json:"price"`
	Stock int     `json:"stock"`
	Image string  `json:"image"`
}

func (s *server) fetchProduct(ctx context.Context, id string) (*product, int, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, s.catalogURL+"/products/"+url.PathEscape(id), nil)
	resp, err := s.httpc.Do(req)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, fmt.Errorf("catalog returned %d", resp.StatusCode)
	}
	var p product
	if err := json.NewDecoder(resp.Body).Decode(&p); err != nil {
		return nil, http.StatusBadGateway, err
	}
	return &p, http.StatusOK, nil
}

func uid(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.Header.Get("X-User-Id")
	if id == "" {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return "", false
	}
	return id, true
}

func (s *server) respondCart(w http.ResponseWriter, u string) {
	cart, err := s.load(u)
	if err != nil {
		log.Printf("redis error: %v", err)
		writeErr(w, http.StatusServiceUnavailable, "cart store unavailable")
		return
	}
	writeJSON(w, http.StatusOK, cart)
}

func (s *server) getCart(w http.ResponseWriter, r *http.Request) {
	if u, ok := uid(w, r); ok {
		s.respondCart(w, u)
	}
}

func (s *server) addItem(w http.ResponseWriter, r *http.Request) {
	u, ok := uid(w, r)
	if !ok {
		return
	}
	var body struct {
		ProductID string `json:"productId"`
		Qty       int    `json:"qty"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil || body.ProductID == "" {
		writeErr(w, http.StatusBadRequest, "productId is required")
		return
	}
	if body.Qty == 0 {
		body.Qty = 1
	}
	if body.Qty < 1 || body.Qty > 99 {
		writeErr(w, http.StatusBadRequest, "qty must be between 1 and 99")
		return
	}
	p, status, err := s.fetchProduct(r.Context(), body.ProductID)
	if err != nil {
		if status == http.StatusNotFound || status == http.StatusBadRequest {
			writeErr(w, http.StatusNotFound, "product not found")
		} else {
			writeErr(w, http.StatusBadGateway, "catalog unavailable")
		}
		return
	}
	cur, err := s.existing(u, p.ID)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "cart store unavailable")
		return
	}
	qty := body.Qty
	if cur != nil {
		qty += cur.Qty
	}
	if qty > p.Stock {
		writeErr(w, http.StatusConflict, fmt.Sprintf("only %d in stock", p.Stock))
		return
	}
	if err := s.save(u, CartItem{ProductID: p.ID, Name: p.Name, Price: p.Price, Image: p.Image, Qty: qty}); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "cart store unavailable")
		return
	}
	s.reg.inc("cart_operations_total", "op", "add")
	s.respondCart(w, u)
}

func (s *server) setQty(w http.ResponseWriter, r *http.Request) {
	u, ok := uid(w, r)
	if !ok {
		return
	}
	pid := r.PathValue("id")
	var body struct {
		Qty int `json:"qty"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil || body.Qty < 0 || body.Qty > 99 {
		writeErr(w, http.StatusBadRequest, "qty must be between 0 and 99")
		return
	}
	if body.Qty == 0 {
		_, _ = s.rdb.Do("HDEL", cartKey(u), pid)
		s.reg.inc("cart_operations_total", "op", "remove")
		s.respondCart(w, u)
		return
	}
	cur, err := s.existing(u, pid)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "cart store unavailable")
		return
	}
	if cur == nil {
		writeErr(w, http.StatusNotFound, "item not in cart")
		return
	}
	cur.Qty = body.Qty
	if err := s.save(u, *cur); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "cart store unavailable")
		return
	}
	s.reg.inc("cart_operations_total", "op", "update")
	s.respondCart(w, u)
}

func (s *server) removeItem(w http.ResponseWriter, r *http.Request) {
	u, ok := uid(w, r)
	if !ok {
		return
	}
	if _, err := s.rdb.Do("HDEL", cartKey(u), r.PathValue("id")); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "cart store unavailable")
		return
	}
	s.reg.inc("cart_operations_total", "op", "remove")
	s.respondCart(w, u)
}

func (s *server) clear(w http.ResponseWriter, r *http.Request) {
	u, ok := uid(w, r)
	if !ok {
		return
	}
	if _, err := s.rdb.Do("DEL", cartKey(u)); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "cart store unavailable")
		return
	}
	s.reg.inc("cart_operations_total", "op", "clear")
	writeJSON(w, http.StatusOK, Cart{Items: []CartItem{}})
}

func main() {
	reg := newRegistry("cart-service")
	s := &server{
		rdb:        newRedis(getenv("REDIS_ADDR", "redis:6379"), 32),
		catalogURL: getenv("CATALOG_SERVICE_URL", "http://catalog-service:3002"),
		httpc:      &http.Client{Timeout: 3 * time.Second},
		ttl:        7 * 24 * 3600,
		reg:        reg,
	}

	for i := 0; i < 30; i++ {
		if _, err := s.rdb.Do("PING"); err == nil {
			break
		} else if i == 29 {
			log.Fatalf("redis unreachable: %v", err)
		}
		time.Sleep(time.Second)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /cart", s.getCart)
	mux.HandleFunc("POST /cart/items", s.addItem)
	mux.HandleFunc("PUT /cart/items/{id}", s.setQty)
	mux.HandleFunc("DELETE /cart/items/{id}", s.removeItem)
	mux.HandleFunc("DELETE /cart", s.clear)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if _, err := s.rdb.Do("PING"); err != nil {
			writeErr(w, http.StatusServiceUnavailable, "redis down")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("GET /metrics", reg.handler())

	routeOf := func(r *http.Request) string {
		if r.Pattern != "" {
			return r.Pattern
		}
		return "unmatched"
	}
	srv := &http.Server{
		Addr:              ":" + getenv("PORT", "3003"),
		Handler:           reg.instrument(routeOf, mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		log.Printf("cart-service listening on %s", srv.Addr)
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
