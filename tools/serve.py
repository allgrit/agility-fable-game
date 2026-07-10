# Dev-сервер без кеша: python tools/serve.py [port] [host]
# host по умолчанию 127.0.0.1; для доступа с телефона укажи LAN-IP машины
# (wildcard 0.0.0.0 на этой машине нестабилен из-за Windows-резервации портов)
import http.server, sys

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8734
host = sys.argv[2] if len(sys.argv) > 2 else '127.0.0.1'
http.server.ThreadingHTTPServer((host, port), NoCacheHandler).serve_forever()
