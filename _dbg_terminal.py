import json, os, sys, time
sys.path.insert(0, "src")
os.environ["MISAKA_WEB_MISAKA_HOME"] = "C:/Users/GJMJi/AppData/Local/Temp/mw-dev/home5"
os.environ["MISAKA_HOME"] = "C:/Users/GJMJi/AppData/Local/Temp/mw-dev/home5"
os.environ["MISAKA_WEB_TOKEN_FILE"] = "C:/Users/GJMJi/AppData/Local/Temp/mw-dev/token"
child = "import sys" + chr(10) + "print('ready', flush=True)" + chr(10) + "for line in sys.stdin:" + chr(10) + "    print('echo:' + line.strip(), flush=True)"
os.environ["MISAKA_WEB_TERMINAL_CMD"] = json.dumps([sys.executable, "-u", "-c", child])
from fastapi.testclient import TestClient
from misaka_web.api.app import create_app
from misaka_web.api import routes_terminal as routes
token = open(os.environ["MISAKA_WEB_TOKEN_FILE"], encoding="utf-8").read().strip()
client = TestClient(create_app())
H = {"Authorization": "Bearer " + token, "user-agent": "dbg"}
ticket = client.post("/api/terminal/ticket", json={"profile": "shell"}, headers=H).json()
with client.websocket_connect(ticket["ws_url"], headers={"user-agent": "dbg"}) as ws:
    print("frame:", ws.receive_json()["type"])
    print("ACTIVE inside:", dict(routes.ACTIVE))
print("ACTIVE after close:", dict(routes.ACTIVE))
for _ in range(40):
    if not any(routes.ACTIVE.values()):
        break
    time.sleep(0.1)
print("ACTIVE later:", dict(routes.ACTIVE))