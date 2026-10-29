"""Synthetic localhost TLS fixture. No outside network connections."""
import http.server
import json
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers["Content-Length"])
        assert size <= 4096
        request = json.loads(self.rfile.read(size))
        assert request["method"] == "getblockcount"
        assert self.headers["Authorization"] == "Basic YWxpY2U6cHc="
        body = json.dumps({"id": request["id"], "result": 0, "error": None}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass

with tempfile.TemporaryDirectory(prefix="tl-rpc-test-tls-") as directory:
    cert = Path(directory) / "cert.pem"
    key = Path(directory) / "key.pem"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", str(key), "-out", str(cert), "-days", "1",
        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(cert), str(key))
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    runner = threading.Thread(target=server.serve_forever, daemon=True)
    runner.start()
    try:
        subprocess.run([
            "cargo", "run", "--locked", "--offline", "--quiet", "--example", "tls_probe",
            "--", f"https://localhost:{server.server_port}/", str(cert)
        ], cwd=Path(__file__).resolve().parents[1], check=True, timeout=90)
        print("TLS untrusted refusal + custom CA acceptance: PASS")
    finally:
        server.shutdown()
        server.server_close()
        runner.join(timeout=5)
