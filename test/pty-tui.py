#!/usr/bin/env python3
"""PTY layout probe for the Ink TUI.

Runs the real tui.mjs with a deterministic agent stand-in, at an exact
cols x rows window, opens the approval panel, pages the transcript up, then
answers the approval and quits. Prints one JSON object with observations.
"""

import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def main():
    cols = int(sys.argv[1]) if len(sys.argv) > 1 else 46
    rows = int(sys.argv[2]) if len(sys.argv) > 2 else 12
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    tui = os.path.join(root, "tui.mjs")
    fake = os.path.join(here, "fake-tui-agent.js")
    env = dict(os.environ)
    env.update({
        "HARNESS_AGENT_BIN": fake,
        "TERM": "xterm-256color",
        "COLUMNS": str(cols),
        "LINES": str(rows),
        "NO_COLOR": "1",
    })

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    proc = subprocess.Popen(
        [os.environ.get("NODE_BIN", "node"), tui, "--no-alt", "--safe"],
        cwd=root,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        preexec_fn=os.setsid,
    )
    os.close(slave)
    os.set_blocking(master, False)

    raw = bytearray()

    def read_for(seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([master], [], [], min(0.08, max(0, end - time.time())))
            if not r:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return
            if not chunk:
                return
            raw.extend(chunk)

    def clean():
        return ANSI.sub("", raw.decode("utf-8", "replace")).replace("\r", "")

    def wait_for(texts, timeout):
        end = time.time() + timeout
        while time.time() < end:
            read_for(0.15)
            body = clean()
            if any(t in body for t in texts):
                return True
        return False

    def send(data):
        os.write(master, data)

    ok_ready = wait_for(["ready", "Ask Copilot", "copilot-harness"], 15)
    send(b"\x16")
    ok_image = wait_for(["Đã dán ảnh", "Clipboard không có"], 10)
    send(b"layout fixture\r")
    ok_approval = wait_for(["Cần xác nhận", "từ chối"], 20)
    before_scroll = len(raw)

    send(b"\x1b[5~")
    time.sleep(0.15)
    send(b"\x1b[5~")
    read_for(0.6)
    after_scroll_bytes = bytes(raw[before_scroll:])
    post_scroll = ANSI.sub("", after_scroll_bytes.decode("utf-8", "replace"))

    send(b"x")
    read_for(0.25)
    send(b"\x1b[6~")
    time.sleep(0.12)
    send(b"\x1b[6~")
    ok_result = wait_for(["Chưa hoàn tất", "fixture denied"], 10)
    read_for(0.3)
    send(b"\x18")
    read_for(0.5)

    body = clean()
    lines = [line for line in body.split("\n") if line.strip()]
    payload = {
        "cols": cols,
        "rows": rows,
        "ready": ok_ready,
        "imagePaste": ok_image and ("Đã dán ảnh" in body),
        "approval": ok_approval,
        "result": ok_result,
        "phase": ("Đang chờ Copilot" in body) or ("Chờ duyệt" in body),
        "direction": "Inspect checkpoint path" in body,
        "directionPartial": "Inspect checkpoint" in body,
        "milestone": "Mốc" in body,
        "scroll": "↑" in body,
        "postScrollActivity": bool(post_scroll.strip()),
        "maxLine": max((len(line) for line in lines), default=0),
        "exited": proc.poll() is not None,
        "tail": "\n".join(lines[-24:]),
    }
    try:
        os.close(master)
    except OSError:
        pass
    try:
        proc.terminate()
    except Exception:
        pass
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
