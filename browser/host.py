#!/usr/bin/env python3
"""Answer the SHU browser extension: which task, if any, refs the page it shows.

Chrome starts this script through Native Messaging and sends one message per
lookup: {"url": "<page URL>"}. Each message, in either direction, is a 4-byte
length in native byte order followed by that many bytes of UTF-8 JSON.

The answer is {"task": null} when nothing refs the page, the output of
`shu show <id> --log 3 --json` with "path" (the task directory) and "page"
added, or {"error": {"code", "message"}} when the lookup fails. "page" is the
page's own part of the task (see page_part), or null; on such a page the log is
read whole and cut to the last 3 here. The script only reads.
"""

import json
import os
import re
import shutil
import struct
import subprocess
import sys
from urllib.parse import urldefrag

LOG_TAIL = 3
# Chrome refuses a message from the host larger than this
MAX_REPLY = 1024 * 1024
# The page is not a ref shu can read, or no task holds it: both mean "nothing here"
NOTHING = ("not_found", "invalid_ref")
INSTALL = "curl -fsSL https://raw.githubusercontent.com/dim0627/shu/main/scripts/install.sh | sh"
UPGRADE = f"If shu is missing or older than 0.6.0, install the latest: {INSTALL}"


def config_path():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "shu", "browser-host.json")


# Chrome started from the Dock gets neither the shell's PATH nor its SHU_HOME, so
# browser/install.sh records both from the shell it runs in
def read_config():
    try:
        with open(config_path(), encoding="utf-8") as f:
            config = json.load(f)
    except (OSError, ValueError):
        return {}
    return config if isinstance(config, dict) else {}


def find_shu(config):
    recorded = config.get("shu")
    if isinstance(recorded, str) and os.access(recorded, os.X_OK):
        return recorded
    return shutil.which("shu")


def shu_json(shu, env, *args):
    try:
        proc = subprocess.run(
            [shu, *args, "--json"], capture_output=True, text=True, encoding="utf-8", errors="replace", env=env
        )
    except OSError as e:
        return {"error": {"code": "host", "message": str(e)}}
    try:
        return json.loads(proc.stdout)
    except ValueError:
        return {"error": {"code": "host", "message": proc.stderr.strip() or f"shu exited with {proc.returncode}"}}


def with_upgrade(reply):
    # An option a build does not know is the one invalid_input a lookup can meet
    if reply["error"].get("code") == "invalid_input":
        reply["error"]["message"] += f". {UPGRADE}"
    return reply


def find(shu, env, url):
    found = shu_json(shu, env, "find", "--ref", url)
    # A url ref keeps its fragment, so an in-page anchor would hide the task
    bare = urldefrag(url).url
    if found.get("error", {}).get("code") == "not_found" and bare != url:
        found = shu_json(shu, env, "find", "--ref", bare)
    return found


GITHUB_PAGE = re.compile(r"^https?://(?:www\.)?github\.com/([^/]+)/([^/]+)/(?:pull|issues)/(\d+)(?:[/?#]|$)", re.I)


# Only a GitHub page has a number that log entries and artifact names also use (#482).
# find has already matched the page to the task, so its ref is the task's
def page_of(url):
    m = GITHUB_PAGE.match(url)
    return (f"{m[1]}/{m[2]}".lower(), str(int(m[3]))) if m else None


def mentions(text, repo, number):
    # `other-org/lib#482` is another repository's #482; a bare #482 is taken as this page's.
    # The names are GitHub's ASCII ones, so a `/` in prose (設計/実装は#482) is not a repository
    for m in re.finditer(rf"(?:(?<![A-Za-z0-9._-])([A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+))?#{number}(?!\d)", text):
        if m[1] is None or m[1].lower() == repo:
            return True
    return False


def page_part(shown, repo, number):
    entries = [e for e in shown["log"] if mentions(e["message"], repo, number)]
    return {
        "number": number,
        "log": entries[-LOG_TAIL:],
        "log_total": len(entries),
        "artifacts": [name for name in shown["artifacts"] if mentions(name, repo, number)],
    }


def lookup(message):
    url = message.get("url") if isinstance(message, dict) else None
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        return {"task": None}
    config = read_config()
    shu = find_shu(config)
    if shu is None:
        return {"error": {"code": "host", "message": f"shu was not found. Run browser/install.sh again. {UPGRADE}"}}
    env = dict(os.environ)
    if not env.get("SHU_HOME") and isinstance(config.get("shu_home"), str):
        env["SHU_HOME"] = config["shu_home"]
    found = find(shu, env, url)
    if "error" in found:
        return {"task": None} if found["error"].get("code") in NOTHING else found
    task_id = found["task"]["id"]
    page = page_of(url)
    # One read for the page's part and the tail, so the two cannot disagree
    shown = shu_json(shu, env, "show", task_id) if page else shu_json(shu, env, "show", task_id, "--log", str(LOG_TAIL))
    if "error" in shown:
        return with_upgrade(shown)
    # A shu older than 0.6.0 knows no --log, and answers show without log_total
    if "log_total" not in shown:
        return {"error": {"code": "invalid_input", "message": f"shu sent no log_total. {UPGRADE}"}}
    if page:
        page = page_part(shown, *page)
        shown = {**shown, "log": shown["log"][-LOG_TAIL:]}
    located = shu_json(shu, env, "path", task_id)
    if "error" in located:
        return with_upgrade(located)
    return {**shown, "path": located["path"], "page": page}


def encode(reply):
    data = json.dumps(reply, ensure_ascii=False).encode("utf-8")
    if len(data) > MAX_REPLY:
        data = json.dumps(
            {"error": {"code": "host", "message": "the task is too large to show; run shu show in a terminal"}}
        ).encode("utf-8")
    return struct.pack("=I", len(data)) + data


def main():
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    while True:
        header = stdin.read(4)
        if len(header) < 4:
            return
        (length,) = struct.unpack("=I", header)
        body = stdin.read(length)
        try:
            message = json.loads(body.decode("utf-8"))
        except ValueError:
            message = None
        # A host that dies sends nothing, and Chrome then blames the install
        try:
            reply = lookup(message)
        except Exception as e:
            reply = {"error": {"code": "host", "message": f"{type(e).__name__}: {e}"}}
        stdout.write(encode(reply))
        stdout.flush()


if __name__ == "__main__":
    main()
