# Dev-сервер без кеша: python tools/serve.py [port]
import http.server, sys

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8734
http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler).serve_forever()
