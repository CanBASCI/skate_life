#!/usr/bin/env python3
"""Minimal PixelLab MCP JSON-RPC client (token from .env / PIXELLAB_API_TOKEN)."""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from pathlib import Path


def load_token() -> str:
    token = os.environ.get("PIXELLAB_API_TOKEN")
    if token:
        return token
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("PIXELLAB_API_TOKEN="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("PIXELLAB_API_TOKEN missing")


class PixelLabMCP:
    def __init__(self, url: str = "https://api.pixellab.ai/mcp"):
        self.url = url
        self.token = load_token()
        self.session = None
        self._id = 0
        self.initialize()

    def _req(self, payload: dict, notify: bool = False):
        data = json.dumps(payload).encode()
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        req = urllib.request.Request(self.url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=180) as resp:
            sid = resp.headers.get("mcp-session-id") or resp.headers.get("Mcp-Session-Id")
            if sid:
                self.session = sid
            body = resp.read().decode()
        if notify:
            return body
        match = re.search(r"data:\s*(\{.*\})", body, re.S)
        return json.loads(match.group(1) if match else body)

    def call(self, method: str, params: dict | None = None):
        self._id += 1
        return self._req({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}})

    def initialize(self):
        self.call(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "skate-life", "version": "0.1"},
            },
        )
        self._req({"jsonrpc": "2.0", "method": "notifications/initialized"}, notify=True)

    def tool(self, name: str, arguments: dict):
        return self.call("tools/call", {"name": name, "arguments": arguments})

    def tool_text(self, name: str, arguments: dict) -> str:
        res = self.tool(name, arguments)
        try:
            return res["result"]["content"][0]["text"]
        except Exception:
            return json.dumps(res, indent=2)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: pixellab_mcp.py <tool_name> '{json args}'")
    tool = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    print(PixelLabMCP().tool_text(tool, args))
