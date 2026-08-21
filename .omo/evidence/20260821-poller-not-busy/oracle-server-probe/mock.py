import http.server, json, time, threading
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_POST(self):
        n=int(self.headers.get('content-length',0)); self.rfile.read(n)
        self.send_response(200)
        self.send_header('content-type','text/event-stream')
        self.send_header('cache-control','no-cache')
        self.end_headers()
        # stream slowly for ~20s so the session stays busy
        for i in range(20):
            chunk={"id":"c1","object":"chat.completion.chunk","created":0,"model":"mock",
                   "choices":[{"index":0,"delta":{"content":f"tok{i} "},"finish_reason":None}]}
            try:
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode()); self.wfile.flush()
            except Exception: return
            time.sleep(1)
        done={"id":"c1","object":"chat.completion.chunk","created":0,"model":"mock",
              "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
        self.wfile.write(f"data: {json.dumps(done)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
    def do_GET(self):
        body=json.dumps({"data":[{"id":"mock","object":"model"}]}).encode()
        self.send_response(200); self.send_header('content-type','application/json')
        self.send_header('content-length',str(len(body))); self.end_headers(); self.wfile.write(body)
http.server.ThreadingHTTPServer(('127.0.0.1',45999),H).serve_forever()
