package main

// Tiny dependency-free Redis client (RESP2) with a connection pool.

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

type redisError string

func (e redisError) Error() string { return string(e) }

type rconn struct {
	c net.Conn
	r *bufio.Reader
}

type redisClient struct {
	addr string
	pool chan *rconn
}

func newRedis(addr string, size int) *redisClient {
	return &redisClient{addr: addr, pool: make(chan *rconn, size)}
}

func (rc *redisClient) get() (*rconn, bool, error) {
	select {
	case c := <-rc.pool:
		return c, false, nil
	default:
	}
	nc, err := net.DialTimeout("tcp", rc.addr, 2*time.Second)
	if err != nil {
		return nil, true, err
	}
	return &rconn{c: nc, r: bufio.NewReader(nc)}, true, nil
}

func (rc *redisClient) put(c *rconn) {
	select {
	case rc.pool <- c:
	default:
		_ = c.c.Close()
	}
}

// Do runs one command. Pooled connections that turn out stale are retried once on a fresh one.
func (rc *redisClient) Do(args ...string) (any, error) {
	for attempt := 0; attempt < 2; attempt++ {
		c, fresh, err := rc.get()
		if err != nil {
			return nil, err
		}
		v, err := c.roundTrip(args)
		var re redisError
		if err == nil || errors.As(err, &re) {
			rc.put(c)
			return v, err
		}
		_ = c.c.Close()
		if fresh {
			return nil, err
		}
	}
	return nil, errors.New("redis: request failed")
}

func (c *rconn) roundTrip(args []string) (any, error) {
	_ = c.c.SetDeadline(time.Now().Add(3 * time.Second))
	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, a := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(a), a)
	}
	if _, err := io.WriteString(c.c, b.String()); err != nil {
		return nil, err
	}
	return readReply(c.r)
}

func readReply(r *bufio.Reader) (any, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	if len(line) < 3 {
		return nil, errors.New("redis: short reply")
	}
	body := line[1 : len(line)-2]
	switch line[0] {
	case '+':
		return body, nil
	case '-':
		return nil, redisError(body)
	case ':':
		return strconv.ParseInt(body, 10, 64)
	case '$':
		n, err := strconv.Atoi(body)
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil
		}
		buf := make([]byte, n+2)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		return string(buf[:n]), nil
	case '*':
		n, err := strconv.Atoi(body)
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil
		}
		arr := make([]any, n)
		for i := range arr {
			v, err := readReply(r)
			if err != nil {
				return nil, err
			}
			arr[i] = v
		}
		return arr, nil
	}
	return nil, fmt.Errorf("redis: unexpected reply %q", line)
}
