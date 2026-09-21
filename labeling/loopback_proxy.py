"""OrbStack internal networks do not publish ports; expose one fixed service on loopback."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import ipaddress
import json
import subprocess
from urllib.parse import urlsplit

HOP = {'connection', 'transfer-encoding', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade'}

def main():
    # Derive the private target from our exact container, never from HTTP input.
    raw = subprocess.check_output(['docker', '--context', 'orbstack', 'inspect', 'inspection-label-studio-local'])
    info = json.loads(raw)[0]
    target = info['NetworkSettings']['Networks']['inspection-labeling-local']['IPAddress']
    if not ipaddress.ip_address(target).is_private:
        raise ValueError('Expected a private container address')
    class Proxy(BaseHTTPRequestHandler):
        def forward(self):
            if not self.path.startswith('/') or self.path.startswith('//') or urlsplit(self.path).netloc:
                self.send_error(400); return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length < 0 or length > 20 * 1024 * 1024 or self.headers.get('Transfer-Encoding'):
                    self.send_error(413); return
                body = self.rfile.read(length) if length else None
                headers = {k:v for k,v in self.headers.items() if k.lower() not in HOP}
                headers['Host'] = '127.0.0.1:8085'
                conn = http.client.HTTPConnection(target, 8080, timeout=60)
                conn.request(self.command, self.path, body=body, headers=headers)
                response = conn.getresponse(); payload = response.read()
                self.send_response(response.status)
                for k,v in response.getheaders():
                    if k.lower() not in HOP | {'content-length'}: self.send_header(k,v)
                self.send_header('Content-Length', str(len(payload))); self.end_headers()
                if self.command != 'HEAD': self.wfile.write(payload)
                conn.close()
            except (OSError, ValueError, http.client.HTTPException):
                self.send_error(502, 'Local Label Studio unavailable')
        do_GET = do_POST = do_PATCH = do_DELETE = do_PUT = do_HEAD = do_OPTIONS = forward
        def log_message(self, *args): pass
    print('Label Studio loopback proxy ready: http://127.0.0.1:8085', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8085), Proxy).serve_forever()

if __name__ == '__main__': main()
