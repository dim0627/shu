#!/usr/bin/env python3
"""Answer the SHU browser extension: which task, if any, refs the page it shows.

Chrome starts this script through Native Messaging and sends one message per
lookup: {"url": "<page URL>"}. Each message, in either direction, is a 4-byte
length in native byte order followed by that many bytes of UTF-8 JSON.

The answer is {"task": null} when nothing refs the page, the output of
`shu show <id> --log 3 --json` with "path" (the task directory) added, or
{"error": {"code", "message"}} when the lookup fails. The script only reads.
"""

import json
import os
import shutil
import struct
import subprocess
import sys
from urllib.parse import urldefrag

LOG_TAIL = "3"
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
    shown = shu_json(shu, env, "show", task_id, "--log", LOG_TAIL)
    if "error" in shown:
        return with_upgrade(shown)
    located = shu_json(shu, env, "path", task_id)
    if "error" in located:
        return with_upgrade(located)
    return {**shown, "path": located["path"]}


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
