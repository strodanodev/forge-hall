"""Tiny client for the MCP-for-Blender addon socket (same protocol the MCP server uses).

usage: python bmcp.py <script.py>        -> execute_code with file contents
       python bmcp.py --cmd <type> [json] -> raw command
"""
import json, socket, sys


def send(cmd_type, params=None, host="localhost", port=9876, timeout=300):
    with socket.create_connection((host, port), timeout=timeout) as s:
        s.sendall(json.dumps({"type": cmd_type, "params": params or {}}).encode())
        buf = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
            try:
                return json.loads(buf.decode())
            except json.JSONDecodeError:
                continue
    return json.loads(buf.decode())


if __name__ == "__main__":
    if sys.argv[1] == "--cmd":
        params = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
        res = send(sys.argv[2], params)
    else:
        code = "\n".join(open(f, encoding="utf-8").read() for f in sys.argv[1:])
        res = send("execute_code", {"code": code})
    out = json.dumps(res, indent=1)
    print(out[:4000])
