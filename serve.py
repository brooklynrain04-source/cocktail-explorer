"""
serve.py - show the website at http://localhost:8000

Usage:
    python serve.py            # then open http://localhost:8000
    python serve.py 9000       # use a different port

Press Ctrl+C in the terminal to stop the server.
"""

import http.server
import os
import socketserver
import sys
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
DATA_FILE = os.path.join(WEB_DIR, "data", "cocktails.json")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def end_headers(self):
        # Always reload fresh files, so re-running fetch_data.py shows up on refresh.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    if not os.path.exists(DATA_FILE):
        print("\nNo data yet: web/data/cocktails.json is missing.")
        print("Run this first:   python fetch_data.py\n")
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as server:
        url = f"http://localhost:{PORT}"
        print(f"Serving the cocktail explorer at {url}  (Ctrl+C to stop)")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
