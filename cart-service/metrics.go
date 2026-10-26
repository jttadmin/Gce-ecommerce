package main

// Minimal, dependency-free Prometheus exposition (counters, gauges, histograms).

import (
	"fmt"
	"net/http"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

var buckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

type hist struct {
	name, labels string
	counts       []uint64
	sum          float64
	count        uint64
}

type registry struct {
	mu       sync.Mutex
	service  string
	counters map[string]float64
	gauges   map[string]float64
	hists    map[string]*hist
}

func newRegistry(service string) *registry {
	return &registry{
		service:  service,
		counters: map[string]float64{},
		gauges:   map[string]float64{},
		hists:    map[string]*hist{},
	}
}

func esc(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return strings.ReplaceAll(s, "\n", `\n`)
}

func (r *registry) labels(kv []string) string {
	var b strings.Builder
	b.WriteString(`service="` + esc(r.service) + `"`)
	for i := 0; i+1 < len(kv); i += 2 {
		fmt.Fprintf(&b, `,%s="%s"`, kv[i], esc(kv[i+1]))
	}
	return b.String()
}

func (r *registry) inc(name string, kv ...string) {
	key := name + "{" + r.labels(kv) + "}"
	r.mu.Lock()
	r.counters[key]++
	r.mu.Unlock()
}

func (r *registry) gaugeAdd(name string, delta float64, kv ...string) {
	key := name + "{" + r.labels(kv) + "}"
	r.mu.Lock()
	r.gauges[key] += delta
	r.mu.Unlock()
}

func (r *registry) observe(name string, v float64, kv ...string) {
	l := r.labels(kv)
	key := name + "{" + l + "}"
	r.mu.Lock()
	h, ok := r.hists[key]
	if !ok {
		h = &hist{name: name, labels: l, counts: make([]uint64, len(buckets))}
		r.hists[key] = h
	}
	for i, b := range buckets {
		if v <= b {
			h.counts[i]++
		}
	}
	h.sum += v
	h.count++
	r.mu.Unlock()
}

func sortedKeys[T any](m map[string]T) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func metricName(key string) string { return key[:strings.IndexByte(key, '{')] }

func (r *registry) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		var b strings.Builder
		r.mu.Lock()
		last := ""
		for _, k := range sortedKeys(r.counters) {
			if n := metricName(k); n != last {
				fmt.Fprintf(&b, "# TYPE %s counter\n", n)
				last = n
			}
			fmt.Fprintf(&b, "%s %g\n", k, r.counters[k])
		}
		last = ""
		for _, k := range sortedKeys(r.gauges) {
			if n := metricName(k); n != last {
				fmt.Fprintf(&b, "# TYPE %s gauge\n", n)
				last = n
			}
			fmt.Fprintf(&b, "%s %g\n", k, r.gauges[k])
		}
		last = ""
		for _, k := range sortedKeys(r.hists) {
			h := r.hists[k]
			if h.name != last {
				fmt.Fprintf(&b, "# TYPE %s histogram\n", h.name)
				last = h.name
			}
			for i, bk := range buckets {
				fmt.Fprintf(&b, "%s_bucket{%s,le=\"%g\"} %d\n", h.name, h.labels, bk, h.counts[i])
			}
			fmt.Fprintf(&b, "%s_bucket{%s,le=\"+Inf\"} %d\n", h.name, h.labels, h.count)
			fmt.Fprintf(&b, "%s_sum{%s} %g\n%s_count{%s} %d\n", h.name, h.labels, h.sum, h.name, h.labels, h.count)
		}
		r.mu.Unlock()

		var ms runtime.MemStats
		runtime.ReadMemStats(&ms)
		svc := esc(r.service)
		fmt.Fprintf(&b, "# TYPE process_goroutines gauge\nprocess_goroutines{service=\"%s\"} %d\n", svc, runtime.NumGoroutine())
		fmt.Fprintf(&b, "# TYPE process_heap_alloc_bytes gauge\nprocess_heap_alloc_bytes{service=\"%s\"} %d\n", svc, ms.HeapAlloc)
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write([]byte(b.String()))
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// instrument records request count, latency and in-flight gauge.
// routeOf is evaluated after the handler ran so it can read mux-resolved data.
func (r *registry) instrument(routeOf func(*http.Request) string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		r.gaugeAdd("http_requests_in_flight", 1)
		defer r.gaugeAdd("http_requests_in_flight", -1)
		next.ServeHTTP(sw, req)
		route := routeOf(req)
		status := fmt.Sprintf("%d", sw.status)
		r.inc("http_requests_total", "route", route, "method", req.Method, "status", status)
		r.observe("http_request_duration_seconds", time.Since(start).Seconds(), "route", route, "method", req.Method)
	})
}
