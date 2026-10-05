package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func loginHandler() http.Handler {
	return basicAuth("admin", "secret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
}

func postLogin(h http.Handler, form url.Values, mutate func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", loginPath, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	if mutate != nil {
		mutate(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func sessionCookieOf(rec *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName {
			return c
		}
	}
	return nil
}

// An iOS home-screen app renders the 401 body instead of a Basic auth
// prompt, so a page load gets the sign-in form; a fetch keeps the plain body.
func TestChallengeServesLoginFormOnNavigation(t *testing.T) {
	h := loginHandler()
	for _, tt := range []struct {
		name    string
		path    string
		headers map[string]string
		form    bool
	}{
		{"navigate", "/?view=chat", map[string]string{"Sec-Fetch-Mode": "navigate"}, true},
		{"accept html without fetch metadata", "/", map[string]string{"Accept": "text/html"}, true},
		{"fetch", "/", map[string]string{"Sec-Fetch-Mode": "cors", "Accept": "text/html"}, false},
		{"api navigation", "/api/mux/snapshot", map[string]string{"Sec-Fetch-Mode": "navigate"}, false},
		{"no headers", "/", nil, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tt.path, nil)
			for k, v := range tt.headers {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
			// Only a client without fetch metadata (curl) is challenged: a
			// browser's prompt would show on top of the form.
			challenged := rec.Header().Get("WWW-Authenticate") != ""
			if want := tt.headers["Sec-Fetch-Mode"] == "" && !tt.form; challenged != want {
				t.Errorf("WWW-Authenticate sent = %v, want %v", challenged, want)
			}
			body := rec.Body.String()
			if got := strings.Contains(body, `action="/login"`); got != tt.form {
				t.Fatalf("login form in body = %v, want %v: %q", got, tt.form, body)
			}
			if tt.form && !strings.Contains(body, `name="next" value="`+tt.path+`"`) {
				t.Errorf("next does not carry %q: %q", tt.path, body)
			}
		})
	}

	// Wrong Basic credentials on a page load also show the form.
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Sec-Fetch-Mode", "navigate")
	req.SetBasicAuth("admin", "wrong")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `action="/login"`) {
		t.Errorf("wrong credentials = %d %q, want 401 with the form", rec.Code, rec.Body.String())
	}
}

func TestLoginGet(t *testing.T) {
	h := loginHandler()
	req := httptest.NewRequest("GET", loginPath+"?next=%2F%3Fview%3Dfiles", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /login = %d, want 200 without credentials", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q", ct)
	}
	if !strings.Contains(rec.Body.String(), `name="next" value="/?view=files"`) {
		t.Errorf("next not kept: %q", rec.Body.String())
	}

	// With a live session it goes straight back.
	ok := postLogin(h, url.Values{"username": {"admin"}, "password": {"secret"}}, nil)
	c := sessionCookieOf(ok)
	if c == nil {
		t.Fatal("no session cookie after a right login")
	}
	req = httptest.NewRequest("GET", loginPath+"?next=/x", nil)
	req.AddCookie(c)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/x" {
		t.Errorf("GET /login with a session = %d %q, want 303 to /x", rec.Code, rec.Header().Get("Location"))
	}
}

func TestLoginPost(t *testing.T) {
	h := loginHandler()

	rec := postLogin(h, url.Values{"username": {"admin"}, "password": {"secret"}, "next": {"/?pane=%251"}}, nil)
	if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/?pane=%251" {
		t.Fatalf("right login = %d %q, want 303 to next", rec.Code, rec.Header().Get("Location"))
	}
	c := sessionCookieOf(rec)
	if c == nil || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" {
		t.Fatalf("session cookie = %+v", c)
	}
	req := httptest.NewRequest("GET", "/api/mux/snapshot", nil)
	req.AddCookie(c)
	got := httptest.NewRecorder()
	h.ServeHTTP(got, req)
	if got.Code != http.StatusOK {
		t.Errorf("request with the form's session = %d, want 200", got.Code)
	}

	rec = postLogin(h, url.Values{"username": {"admin "}, "password": {"secret"}}, nil)
	if rec.Code != http.StatusSeeOther {
		t.Errorf("username with a trailing space = %d, want 303", rec.Code)
	}
	rec = postLogin(h, url.Values{"username": {"admin"}, "password": {"secret "}}, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("password with a trailing space = %d, want 401: it is never trimmed", rec.Code)
	}

	rec = postLogin(h, url.Values{"username": {"admin"}, "password": {"wrong"}, "next": {"/a"}}, nil)
	if rec.Code != http.StatusUnauthorized || sessionCookieOf(rec) != nil {
		t.Fatalf("wrong login = %d, want 401 without a cookie", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "Wrong username or password.") || !strings.Contains(body, `value="/a"`) {
		t.Errorf("wrong login body = %q", body)
	}
	// Only the password is typed again: the username comes back, never the
	// password, and the password field takes the focus.
	if !strings.Contains(body, `name="username" value="admin"`) || strings.Contains(body, "wrong\"") ||
		!strings.Contains(body, `required autofocus>`) || strings.Contains(body, `spellcheck="false" required autofocus`) {
		t.Errorf("wrong login body = %q", body)
	}
	if rec.Header().Get("WWW-Authenticate") != "" {
		t.Error("the form's error must not raise the browser's Basic prompt")
	}

	rec = postLogin(h, url.Values{"username": {"admin"}, "password": {"secret"}, "next": {"//evil.example/"}}, nil)
	if rec.Header().Get("Location") != "/" {
		t.Errorf("next to another host = %q, want /", rec.Header().Get("Location"))
	}
}

func TestLoginPostRejected(t *testing.T) {
	h := loginHandler()
	right := url.Values{"username": {"admin"}, "password": {"secret"}}
	for _, tt := range []struct {
		name   string
		mutate func(*http.Request)
		want   int
	}{
		{"cross-site", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, http.StatusForbidden},
		{"same-site", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-site") }, http.StatusForbidden},
		{"json", func(r *http.Request) { r.Header.Set("Content-Type", "application/json") }, http.StatusUnsupportedMediaType},
		{"multipart", func(r *http.Request) { r.Header.Set("Content-Type", "multipart/form-data; boundary=x") }, http.StatusUnsupportedMediaType},
		{"too large", func(r *http.Request) {
			r.Body = io.NopCloser(strings.NewReader("password=" + strings.Repeat("a", maxLoginBody+1)))
			r.ContentLength = -1
		}, http.StatusBadRequest},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := postLogin(h, right, tt.mutate)
			if rec.Code != tt.want || sessionCookieOf(rec) != nil {
				t.Errorf("status = %d, want %d and no cookie", rec.Code, tt.want)
			}
		})
	}

	// A typed URL or a curl call carries no Sec-Fetch-Site, or "none".
	for _, site := range []string{"", "none"} {
		rec := postLogin(h, right, func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", site) })
		if rec.Code != http.StatusSeeOther {
			t.Errorf("Sec-Fetch-Site %q = %d, want 303", site, rec.Code)
		}
	}

	for _, m := range []string{"PUT", "DELETE", "HEAD"} {
		req := httptest.NewRequest(m, loginPath, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "GET, POST" {
			t.Errorf("%s /login = %d, want 405 with Allow", m, rec.Code)
		}
	}
}

// A browser too old to send Sec-Fetch-Site (Safari before 16.4) still sends
// Origin on a form another site posts: a foreign one is refused before the
// rate limiter counts it, so that site cannot lock the user out.
func TestLoginPostForeignOriginWithoutFetchMetadata(t *testing.T) {
	h := newTestHandler(t, &fakeMux{})
	right := url.Values{"username": {"admin"}, "password": {"secret"}}
	post := func(origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", loginPath, strings.NewReader(right.Encode()))
		req.Host = "localhost:7680"
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		return serve(h, req)
	}
	for _, origin := range []string{"https://evil.example", "http://localhost.evil.example:7680"} {
		if rec := post(origin); rec.Code != http.StatusForbidden || sessionCookieOf(rec) != nil {
			t.Errorf("Origin %q = %d, want 403 and no cookie", origin, rec.Code)
		}
	}
	// The form's own origin; none (curl); "null", which a browser following
	// the Fetch spec sends on this page's form under its no-referrer policy.
	for _, origin := range []string{"http://localhost:7680", "", "null"} {
		if rec := post(origin); rec.Code != http.StatusSeeOther {
			t.Errorf("Origin %q = %d, want 303", origin, rec.Code)
		}
	}
}

// The form shares Basic auth's limiter: wrong passwords by either way add up,
// and a blocked client cannot log in even with the right one.
func TestLoginPostRateLimited(t *testing.T) {
	h := loginHandler()
	for i := 0; i < authMaxFailures-1; i++ {
		postLogin(h, url.Values{"username": {"admin"}, "password": {"wrong"}}, nil)
	}
	req := httptest.NewRequest("GET", "/api/test", nil)
	req.SetBasicAuth("admin", "wrong")
	h.ServeHTTP(httptest.NewRecorder(), req)

	rec := postLogin(h, url.Values{"username": {"admin"}, "password": {"secret"}}, nil)
	if rec.Code != http.StatusTooManyRequests || sessionCookieOf(rec) != nil {
		t.Fatalf("blocked login = %d, want 429 without a cookie", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Too many failed attempts") {
		t.Errorf("blocked body = %q", rec.Body.String())
	}
}

func TestSafeNext(t *testing.T) {
	for in, want := range map[string]string{
		"":                      "/",
		"/":                     "/",
		"/?view=chat&pane=%251": "/?view=chat&pane=%251",
		"/#x":                   "/#x",
		"relative":              "/",
		"https://evil.example/": "/",
		"//evil.example/":       "/",
		"/\\evil.example/":      "/",
		"/\r\nSet-Cookie: x=y":  "/",
		"/login":                "/",
		"/login?next=/":         "/",
		"/%zz":                  "/",
		"/loginx":               "/loginx",
		"/api/mux/snapshot?x=1": "/api/mux/snapshot?x=1",
	} {
		if got := safeNext(in); got != want {
			t.Errorf("safeNext(%q) = %q, want %q", in, got, want)
		}
	}
}
