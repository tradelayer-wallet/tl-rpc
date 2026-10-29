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
    ca_cert = Path(directory) / "ca.pem"
    ca_key = Path(directory) / "ca.key"
    leaf_cert = Path(directory) / "leaf.pem"
    leaf_key = Path(directory) / "leaf.key"
    csr = Path(directory) / "leaf.csr"
    extensions = Path(directory) / "server.ext"
    extensions.write_text(
        "subjectAltName=DNS:localhost,IP:127.0.0.1\n"
        "basicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\n"
    )
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", str(ca_key), "-out", str(ca_cert), "-days", "1",
        "-subj", "/CN=TL-Local-Test-CA",
        "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([
        "openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes",
        "-keyout", str(leaf_key), "-out", str(csr),
        "-subj", "/CN=localhost",
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([
        "openssl", "x509", "-req", "-in", str(csr),
        "-CA", str(ca_cert), "-CAkey", str(ca_key), "-CAcreateserial",
        "-out", str(leaf_cert), "-days", "1", "-sha256", "-extfile", str(extensions),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(leaf_cert), str(leaf_key))
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    runner = threading.Thread(target=server.serve_forever, daemon=True)
    runner.start()
    try:
        subprocess.run([
            "cargo", "run", "--locked", "--offline", "--quiet", "--example", "tls_probe",
            "--", f"https://127.0.0.1:{server.server_port}/", str(ca_cert)
        ], cwd=Path(__file__).resolve().parents[1], check=True, timeout=90)
        print("TLS untrusted refusal + custom CA acceptance: PASS")
    finally:
        server.shutdown()
        server.server_close()
        runner.join(timeout=5)
