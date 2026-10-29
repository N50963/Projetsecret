"""Récupère tous les tickets Lidl Plus France (liste + détail v3) dans un dossier local.

Usage : python services/lidl/fetch_all.py DOSSIER
DOSSIER doit contenir un fichier `refresh_token` (obtenu avec tools/lidl_manual_auth.py).
Écrit DOSSIER/all_list.json et DOSSIER/details/<id>.json. Ne jamais commiter ce dossier :
il contient les achats personnels et le token.
"""
import base64, json, sys, time
from datetime import datetime, timedelta
from pathlib import Path
import requests
D = Path(sys.argv[1]); (D / "details").mkdir(exist_ok=True)
state = {"tok": None, "exp": datetime.min}
sec = base64.b64encode(b"LidlPlusNativeClient:secret").decode()
def access():
    if state["tok"] and datetime.now() < state["exp"] - timedelta(seconds=60):
        return state["tok"]
    rt = (D / "refresh_token").read_text().strip()
    r = requests.post("https://accounts.lidl.com/connect/token",
        headers={"Authorization": f"Basic {sec}", "Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "refresh_token", "refresh_token": rt}, timeout=20)
    r.raise_for_status(); j = r.json()
    if j.get("refresh_token") and j["refresh_token"] != rt:
        (D / "refresh_token").write_text(j["refresh_token"] + "\n"); print("token tourné, nouveau enregistré")
    state.update(tok=j["access_token"], exp=datetime.now() + timedelta(seconds=j["expires_in"]))
    return state["tok"]
def get(url, **kw):
    for attempt in range(4):
        h = {"Authorization": f"Bearer {access()}", "App-Version": "17.9.3", "Operating-System": "iOs",
             "App": "com.lidl.eci.lidl.plus", "Accept-Language": "fr"}
        r = requests.get(url, headers=h, timeout=30, **kw)
        if r.status_code in (429, 500, 502, 503): time.sleep(2 ** attempt); continue
        return r
    return r
tickets, page = [], 1
while True:
    r = get("https://tickets.lidlplus.com/api/v2/FR/tickets", params={"pageNumber": page, "onlyFavorite": "false"})
    r.raise_for_status(); p = r.json(); tickets += p["tickets"]
    if not p["tickets"] or len(tickets) >= p["totalCount"]: break
    page += 1
(D / "all_list.json").write_text(json.dumps(tickets, ensure_ascii=False))
print("liste:", len(tickets), "tickets,", len({t['id'] for t in tickets}), "ids uniques")
fail = []
for i, t in enumerate(tickets, 1):
    f = D / "details" / f"{t['id']}.json"
    if f.exists(): continue
    r = get(f"https://tickets.lidlplus.com/api/v3/FR/tickets/{t['id']}")
    if not r.ok: fail.append((t["id"], r.status_code)); continue
    f.write_bytes(r.content); time.sleep(0.2)
print("détails:", len(list((D / 'details').glob('*.json'))), "| échecs:", fail)
