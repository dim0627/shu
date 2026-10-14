#!/usr/bin/env python3
"""Answer the SHU browser extension: which task, if any, refs the page it shows.

Chrome starts this script through Native Messaging and sends one message per
lookup: {"url": "<page URL>"}. Each message, in either direction, is a 4-byte
length in native byte order followed by that many bytes of UTF-8 JSON.

The answer is {"task": null} when no task refs the page, or the output of
`shu show <id> --log 3 --json` with "path" (the task directory) added, or
{"error": {"code", "message"}} when shu fails. The script only reads.
"""

import json
import os
import shutil
import struct
import subprocess
import sys

LOG_TAIL = "3"
# Chrome refuses a message from the host larger than this
MAX_REPLY = 1024 * 1024
# Chrome started from the Dock or Finder gets a PATH without these
FALLBACK_DIRS = ("~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin")
# The page is not a ref shu can read, or no task holds it: both mean "nothing here"
NOTHING = ("not_found", "invalid_ref")


def find_shu():
    found = shutil.which("shu")
    if found:
        return found
    for d in FALLBACK_DIRS:
        path = os.path.join(os.path.expanduser(d), "shu")
        if os.access(path, os.X_OK):
            return path
    return None


def shu_json(shu, *args):
    try:
        proc = subprocess.run([shu, *args, "--json"], capture_output=True, text=True, encoding="utf-8")
    except OSError as e:
        return {"error": {"code": "host", "message": str(e)}}
    try:
        return json.loads(proc.stdout)
    except ValueError:
        return {"error": {"code": "host", "message": proc.stderr.strip() or f"shu exited with {proc.returncode}"}}


def lookup(message):
    url = message.get("url") if isinstance(message, dict) else None
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        return {"task": None}
    shu = find_shu()
    if shu is None:
        searched = ", ".join(("PATH",) + FALLBACK_DIRS)
        return {"error": {"code": "host", "message": f"shu was not found in {searched}"}}
    found = shu_json(shu, "find", "--ref", url)
    if "error" in found:
        return {"task": None} if found["error"].get("code") in NOTHING else found
    task_id = found["task"]["id"]
    shown = shu_json(shu, "show", task_id, "--log", LOG_TAIL)
    if "error" in shown:
        return shown
    located = shu_json(shu, "path", task_id)
    if "error" in located:
        return located
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
        stdout.write(encode(lookup(message)))
        stdout.flush()


if __name__ == "__main__":
    main()
