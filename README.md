# Mobile Py IDE 🐍

A lightweight, sandboxed, **mobile-optimized** web Python IDE. Built for one
person to run small Python programs from a phone browser — no heavy desktop
IDE, no bloated web app, just a fast editor and a safe place to press **Run**.

- **Zero npm dependencies** — the backend uses only Node's built-in modules.
  Nothing to `npm install`, fewer things to break.
- **Tiny frontend** — one HTML page, one CSS file, one JS file. CodeMirror 6 is
  loaded from a CDN, with a plain-textarea fallback if the CDN is unreachable.
- **Mobile-first UI** — dark theme, large touch targets, Code/Console/Input
  tabs, and a scrollable symbol bar so you can type `:`, `(`, `"`, `_`, `print()`
  and `for` without fighting the phone keyboard.
- **Sandboxed runner** — each program runs in its own temp file, as a resource
  limited subprocess, with a wall-clock timeout, a memory cap, a minimal
  environment and no file/network access.

---

## Architecture

```
[ phone browser ]
      │  code + stdin (JSON)
      ▼
[ Cloudflare Tunnel / Zero Trust ]   (optional, for remote access + TLS)
      │
      ▼
[ Nginx reverse proxy ]              (optional)
      │
      ▼
[ Node.js HTTP server ]  server/app.js
      │   ├─ validator.js   pre-execution checks (blocked imports/calls)
      │   ├─ executor.js    sandboxed subprocess + limits
      │   └─ /tmp/…         ephemeral .py file, deleted after each run
      ▼
[ python3 -I -B -q  under ulimit ]
      │
      ▼
[ stdout / stderr ] → JSON → console on the phone
```

## Project layout

```
mobile-py-ide/
├── package.json
├── .env.example
├── server/
│   ├── app.js         # zero-dep HTTP server + static file serving + API
│   ├── config.js      # all tunables (env-driven)
│   ├── validator.js   # blocked imports, blocked calls, allow-list mode
│   └── executor.js    # temp file, ulimit, timeout, output caps, cleanup
├── public/
│   ├── index.html     # mobile tab layout
│   ├── style.css      # dark, mobile-first styles
│   └── main.js        # CodeMirror + API calls + symbol bar
├── deploy/
│   ├── nginx.conf     # example reverse proxy
│   └── mobile-py-ide.service  # systemd unit
└── test/run-tests.js  # dependency-free test suite
```

---

## Quick start (local)

Requires **Node.js 20+** and **Python 3.10+** on the server.

```bash
git clone https://github.com/<you>/mobile-py-ide.git
cd mobile-py-ide
npm start
# -> Mobile Py IDE running at http://127.0.0.1:3000
```

Open `http://127.0.0.1:3000`. Run the tests with:

```bash
npm test
```

## Configuration

Copy `.env.example` to `.env` and edit. Highlights:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (keep loopback behind a proxy) |
| `TIMEOUT_MS` | `5000` | Wall-clock limit per run |
| `MEMORY_LIMIT_MB` | `128` | Virtual-memory cap (`ulimit -v`) |
| `STRICT_MODE` | `false` | `true` = only allow-listed modules may be imported |
| `DISABLE_NETWORK` | `false` | Wrap the runner in `unshare -n` (needs root or userns) |
| `RUN_AS_UID` / `RUN_AS_GID` | – | Run the runner as a low-privilege user |
| `RATE_MAX` | `60` | Max runs per IP per `RATE_WINDOW_MS` |
| `MAX_CONCURRENT_RUNS` | `2` | Programs executing at the same time (memory guard) |
| `MAX_QUEUE` | `8` | Runs allowed to wait for a free slot before a 429 |

> **Note on the memory cap.** The sandbox default is 128 MB. Small scripts and
> `math`/`random`/`json` run comfortably, but `numpy` can reserve a lot of
> virtual memory and may need a higher `MEMORY_LIMIT_MB`. Raise it if a light
> library fails to import; the cap exists to stop runaway loops, not to be tiny.

## Server sizing

This IDE is deliberately small. A **2 GB RAM / 5 GB disk** VPS is more than
enough for personal use — the app is ~50 KB of code, Node idles at ~60–80 MB,
and each run is capped at `MEMORY_LIMIT_MB`. There is no `node_modules` (the
backend has zero dependencies) and the editor is loaded from a CDN, so nothing
heavy is stored on disk.

- **Concurrency.** `MAX_CONCURRENT_RUNS` (default `2`) keeps a small server
  safe: at most two programs execute at once, the rest wait in a short queue.
  On 2 GB you can raise it to 3–4 if you like, but 2 is a sensible default.
- **Swap.** Add 1–2 GB of swap so a memory spike slows the box down instead of
  triggering the OOM killer:

  ```bash
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```

## Deploying on a VPS

1. **Install** Node 20+ and Python 3.10+ on the server.
2. **Copy** the project to e.g. `/opt/mobile-py-ide` and create a `mobilepy`
   user to own it.
3. **Service** — install the systemd unit from `deploy/mobile-py-ide.service`
   (edit `WorkingDirectory` / `User` first), then
   `sudo systemctl enable --now mobile-py-ide`.
4. **Reverse proxy** — install `deploy/nginx.conf`, set your `server_name`, and
   reload Nginx. Keep the app bound to `127.0.0.1`.
5. **Remote access** — for phone access without opening ports, put a
   Cloudflare Tunnel in front of Nginx (the app expects
   `X-Forwarded-For` / `X-Forwarded-Proto`, which the proxy sets for you).

### Hardening the runner

For a shared or public server, set `RUN_AS_UID`/`RUN_AS_GID` so the runner drops
privileges, and try `DISABLE_NETWORK=true`. Network isolation uses
`unshare -n`, which needs either root or enabled user-namespaces
(`sysctl kernel.unprivileged_userns_clone=1` on some distros) — verify it works
on your host before relying on it.

---

## What the validator blocks

Before any code runs, `validator.js` strips strings and comments (so text that
merely *looks* like code can't fool it) and then refuses:

- **Heavy / ML libraries:** `torch`, `tensorflow`, `keras`, `transformers`,
  `jax`, `cv2`, `sklearn`, `scipy`, `pandas`, `matplotlib`, …
- **OS / process / network:** `os`, `subprocess`, `ctypes`, `multiprocessing`,
  `socket`, `pty`, `resource`, `signal`, `ftplib`, `smtplib`, `paramiko`, …
- **Dynamic import / serialization:** `importlib`, `runpy`, `pickle`, `marshal`, …
- **Dangerous calls:** `eval`, `exec`, `compile`, `open`, `__import__`,
  `globals`, `locals`, `setattr`, `delattr`, …
- **Sandbox-escape attributes:** `__subclasses__`, `__globals__`,
  `__builtins__`, `__class__`, `__code__`, …

Set `STRICT_MODE=true` to flip to an **allow-list** instead — only built-in
safe modules plus whatever you add via `EXTRA_ALLOWED_MODULES` may be imported.

Extend either list without touching code:

```bash
EXTRA_BLOCKED_MODULES=pillow,imageio
EXTRA_ALLOWED_MODULES=sympy
```

---

## API

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/health` | – | `{ ok, timeout_ms, memory_limit_mb, strict_mode }` |
| `POST` | `/api/run` | `{ "code": "...", "stdin": "..." }` | execution result |

Example:

```bash
curl -s localhost:3000/api/run \
  -H 'Content-Type: application/json' \
  -d '{"code":"import math\nprint(math.pi)"}'
```

```json
{
  "status": "success",
  "stdout": "3.141592653589793\n",
  "stderr": "",
  "output": "3.141592653589793\n",
  "exit_code": 0,
  "execution_time": "0.06s",
  "execution_time_ms": 60,
  "truncated": false
}
```

`status` is one of `success`, `error`, `timeout`, or `rejected` (blocked by the
validator).

---

## Notes & limitations

- This is a personal tool, not a hardened multi-tenant service. The validator
  and resource limits raise the bar a lot, but if you ever expose it publicly,
  also run the runner as a dedicated low-privilege user and consider a
  container/VM per execution.
- Because `os` and file access are blocked, programs can't read or write files;
  use `input()` (fed by the **Input** tab) for data.
- CodeMirror is pulled from `esm.sh`; if you want a fully offline IDE, download
  the CodeMirror bundle and serve it locally, or just let the textarea fallback
  take over.

## License

MIT — see [LICENSE](LICENSE).
