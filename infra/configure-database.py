"""Create dedicated SQL credentials directly in Secret Manager; never print them.

Requires the operator's gcloud authentication. Tokens/passwords are retained in
process memory only, not passed in shell arguments or written to local files.
"""
import base64
import json
import os
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

project = os.environ.get("PROJECT_ID", "yours-511602")
region = os.environ.get("REGION", "asia-northeast1")
token = subprocess.check_output(["gcloud", "auth", "print-access-token", "--project=" + project], text=True).strip()


def call(method, url, body=None, missing_ok=False):
    request = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404 and missing_ok:
            return None
        # API responses for user operations might echo input. Never log them.
        raise RuntimeError(f"Cloud API {method} failed with HTTP {error.code}") from None


def wait(operation):
    name = operation["name"]
    for _ in range(60):
        status = call("GET", f"https://sqladmin.googleapis.com/sql/v1beta4/projects/{project}/operations/{name}")
        if status["status"] == "DONE":
            if status.get("error"):
                raise RuntimeError("Cloud SQL operation failed")
            return
        time.sleep(2)
    raise RuntimeError("Cloud SQL operation remains in progress")


sql = f"https://sqladmin.googleapis.com/sql/v1beta4/projects/{project}/instances/yours-db"
sm = f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets"
if not call("GET", sql + "/databases/yours", missing_ok=True):
    wait(call("POST", sql + "/databases", {"name": "yours", "charset": "UTF8"}))
print("Dedicated database ready.")
for purpose in ("migrate", "runtime"):
    name = "yours-db-" + purpose
    secret = call("GET", sm + "/" + name, missing_ok=True)
    if secret and call("GET", sm + "/" + name + "/versions/latest", missing_ok=True):
        print(name + " already configured.")
        continue
    password = secrets.token_urlsafe(36)
    username = "yours_" + purpose
    users = call("GET", sql + "/users").get("items", [])
    if any(user["name"] == username for user in users):
        raise RuntimeError("SQL user exists without its managed secret; inspect before changing credentials")
    wait(call("POST", sql + "/users", {"name": username, "password": password}))
    if not secret:
        call("POST", sm + "?secretId=" + name, {"replication": {"automatic": {}}})
    host = urllib.parse.quote(f"/cloudsql/{project}:{region}:yours-db", safe="")
    url = f"postgresql://{username}:{password}@localhost/yours?host={host}"
    call("POST", sm + "/" + name + ":addVersion", {"payload": {"data": base64.b64encode(url.encode()).decode()}})
    print(name + " created in Secret Manager.")
