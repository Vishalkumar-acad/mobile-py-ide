# PyPad 🐍

A lightweight, sandboxed Python IDE that works on your **phone and your
desktop**. Write Python in a browser, press **Run**, and watch it work —
including a **live console** where `input()` pauses and waits for you to type,
just like a real terminal.

- **Live console.** Programs stream their output as they run and can ask for
  input mid-run. No more `EOFError` because you forgot to fill a box first.
- **Works on phone and desktop.** One page: tabs and a symbol bar on a phone,
  a two-pane editor/console layout on a wide screen.
- **Three modes.** Script (run the editor), **REPL** (an interactive Python
  prompt), and an optional **Terminal**.
- **Install packages from the IDE.** Tap Packages, pick from a reviewed
  allow-list of light libraries, watch pip run.
- **Zero npm dependencies.** The backend uses only Node's built-in modules —
  nothing to `npm install`, fewer things to break.
- **Sandboxed runner.** Every program runs in its own temp folder, as a
  resource-limited subprocess, with CPU/memory caps, an idle timeout and no
  file or network access.

📖 **[Read the guide](https://vishalkumar-acad.github.io/mobile-py-ide/)** (GitHub Pages)

---

## Architecture

```
[ phone / desktop browser ]
      │  code, then live stdin ⇄ SSE output
      ▼
[ Cloudflare Tunnel + Access ]   (optional: private access, no open ports)
      │
      ▼
[ Nginx reverse proxy ]          (optional; buffering off for SSE)
      │
      ▼
[ Node.js HTTP server ]  server/app.js   (zero dependencies)
      │   ├─ validator.js   pre-execution checks
      │   ├─ runs.js        streaming run engine (spawn, limits, stdin, SSE)
      │   └─ /tmp/…         ephemeral .py file, deleted after each run
      ▼
[ python3 -I -B -q -u  under ulimit ]
      │
      ▼
[ stdout / stderr ] → streamed to the console on the page
```

## Project layout

```
mobile-py-ide/
├── package.json
├── .env.example
├── server/
│   ├── app.js         # zero-dep HTTP server, static files, API, SSE
│   ├── config.js      # all tunables (env-driven)
│   ├── validator.js   # blocked imports, blocked calls, allow-list mode
│   ├── runs.js        # interactive streaming run engine (python + bash)
│   ├── modes.js       # the REPL driver source
│   ├── packages.js    # allow-listed pip installs
│   └── executor.js    # one-shot wrapper around runs.js
├── public/
│   ├── index.html     # responsive layout (mobile tabs + desktop split)
│   ├── style.css      # dark theme, mobile-first, desktop breakpoint
│   └── main.js        # CodeMirror + streaming client + symbol bar
├── docs/              # the GitHub Pages user guide
├── deploy/
│   ├── bootstrap.sh   # one-command install (Node, venv, systemd, swap, nginx)
│   ├── add-packages.sh# pip install extra libraries for the runner
│   ├── cloudflare-tunnel.sh
│   ├── nginx.conf
│   └── mobile-py-ide.service
├── .github/workflows/
│   ├── deploy.yml     # auto-deploy on push (SSH secrets)
│   └── pages.yml      # publish docs/ to GitHub Pages
└── test/run-tests.js  # dependency-free test suite (22 tests)
```

---

## Quick start (local)

Requires **Node.js 20+** and **Python 3.10+**.

```bash
git clone https://github.com/Vishalkumar-acad/mobile-py-ide.git
cd mobile-py-ide
npm start          # -> http://127.0.0.1:3000
npm test           # 22 tests
```

## Using it

- **Code** tab — write Python. The symbol bar inserts `:`, `(`, `"`, `_` and
  snippets like `print()`, `input()`, `for`.
- **Console** tab — output appears live. When the program calls `input()`, its
  prompt shows and the **›** line at the bottom becomes active: type a line,
  press Enter, and it continues.
- **Pre-fill input** — optional; lines you want sent the moment the run starts.
- **Run / Stop** — the same button; it becomes Stop while a program runs.
- <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd> runs without the button.

On a screen wider than 860px the tabs disappear and the editor and console sit
side by side.

## Modes

The console has three modes:

- **Script** — runs the code in the editor (the default).
- **REPL** — an interactive Python prompt; press Run, then type one line at a
  time and see each result immediately. Variables persist between lines.
- **Terminal** — a shell on the server. **Off by default**: enable it with
  `ALLOW_TERMINAL=true` in `.env`. Only do this while the IDE stays private
  (behind Cloudflare Access) — it is remote shell access.

## Configuration

Copy `.env.example` to `.env` and edit. Highlights:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (keep loopback behind a proxy) |
| `TIMEOUT_MS` | `5000` | Cap for the one-shot `/api/run` |
| `RUN_IDLE_MS` | `30000` | Stop an interactive run after this much inactivity |
| `RUN_MAX_MS` | `120000` | Absolute cap for an interactive run |
| `MEMORY_LIMIT_MB` | `128` | Virtual-memory cap (`ulimit -v`) |
| `MAX_CONCURRENT_RUNS` | `2` | Programs running at once (memory guard) |
| `MAX_QUEUE` | `8` | Runs allowed to wait before a 429 |
| `REPL_IDLE_MS` / `REPL_MAX_MS` | `300000` / `1800000` | REPL and terminal session limits |
| `ALLOW_PACKAGE_INSTALL` | `true` | Allow allow-listed pip installs from the IDE |
| `EXTRA_PACKAGES` | – | Extra package names to allow |
| `ALLOW_TERMINAL` | `false` | Enable the shell (terminal) mode |
| `STRICT_MODE` | `false` | `true` = only allow-listed modules may be imported |
| `UNBLOCK_MODULES` | – | Remove names from the built-in blocked list |
| `DISABLE_NETWORK` | `false` | Wrap the runner in `unshare -n` (needs root or userns) |
| `RUN_AS_UID` / `RUN_AS_GID` | – | Run the runner as a low-privilege user |

> **Memory.** The sandbox default is 128 MB per program. Small scripts and
> `math`/`random`/`json` are comfortable; `numpy` may need a higher
> `MEMORY_LIMIT_MB`. The cap exists to stop runaway loops, not to be tiny.

## Installing extra libraries

The runner uses a virtual environment created by the bootstrap, so pip installs
land somewhere isolated and safe.

**From the IDE:** tap **Packages** in the top bar, type a name (or tap one of
the chips — those are exactly the allowed ones) and press Install. Only light,
well-known packages are accepted; heavy libraries are refused on purpose.
Extend the list with `EXTRA_PACKAGES` in `.env`.

**From a shell on the server:**

```bash
sudo bash deploy/add-packages.sh rich tabulate
# then: import rich
```

The systemd unit grants the service write access to the venv (and `/tmp`) so
pip can install; everything else on the system stays read-only.

The IDE does not run arbitrary `pip` from the browser on purpose — letting a
web page install any code onto the server is a security hole, and a heavy
package can exhaust a small box.

## Server sizing

A **2 GB RAM / 5 GB disk** VPS is more than enough: the app is ~50 KB of code,
Node idles at ~60–80 MB, and each run is capped at `MEMORY_LIMIT_MB`. There is
no `node_modules` and the editor loads from a CDN, so little is stored on disk.
Add 1–2 GB of swap so a spike slows the box instead of triggering the OOM
killer:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## Deploying on a VPS

### One command (Ubuntu / Debian)

```bash
curl -fsSL https://raw.githubusercontent.com/Vishalkumar-acad/mobile-py-ide/main/deploy/bootstrap.sh -o bootstrap.sh
less bootstrap.sh
sudo bash bootstrap.sh
```

Installs Node 20, creates a low-privilege user, clones to `/opt/mobile-py-ide`,
builds a Python venv, installs a hardened systemd service, adds swap if the box
has none, and sets up nginx. Override with env vars, e.g.
`sudo SETUP_NGINX=no bash bootstrap.sh`.

### Public URL with Cloudflare Tunnel (private access)

1. Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared, name it
   `mobile-py-ide`, copy the install token.
2. On the server: `sudo bash deploy/cloudflare-tunnel.sh <TUNNEL_TOKEN>`
3. Add a Public Hostname: `ide` / `pixelabs.in` → `HTTP` → `localhost:3000`.
4. Lock it down: Zero Trust → Access → Applications → Add a self-hosted app for
   `ide.pixelabs.in`, policy **Allow** where **Emails = you@pixelabs.in**.

With a tunnel you can close inbound 80/443 entirely — `cloudflared` dials out.
Install with `SETUP_NGINX=no` when using a tunnel.

## Auto-deploy with GitHub Actions

`.github/workflows/deploy.yml` updates the app on every push to `main`. Add
these repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `SSH_HOST` | server IP or hostname |
| `SSH_USER` | `ubuntu` (or your login user) |
| `SSH_PRIVATE_KEY` | the full private key, including the `BEGIN`/`END` lines |

Optional: `SSH_PORT`, `APP_DIR`, `HEALTH_URL`. If the secrets are absent the
workflow skips quietly.

**Use a dedicated deploy key, not your main one:**

```bash
ssh-keygen -t ed25519 -f ~/.ssh/deploy_key -N "" -C "github-actions"
cat ~/.ssh/deploy_key.pub >> ~/.ssh/authorized_keys
```

Never paste a private key into a chat, an issue, or a commit.

## The guide site

`docs/` is a self-contained user guide published to GitHub Pages by
`.github/workflows/pages.yml`. Enable it once in **Settings → Pages → Build and
deployment → Source: GitHub Actions**.

---

## What the validator blocks

Before anything runs, `validator.js` strips strings and comments (so text that
merely *looks* like code can't fool it) and refuses:

- **Heavy / ML libraries:** `torch`, `tensorflow`, `keras`, `transformers`,
  `jax`, `cv2`, `sklearn`, `scipy`, `pandas`, `matplotlib`, …
- **OS / process / network:** `os`, `subprocess`, `ctypes`, `multiprocessing`,
  `socket`, `pty`, `resource`, `signal`, `ftplib`, `smtplib`, `paramiko`, …
- **Dynamic import / serialization:** `importlib`, `runpy`, `pickle`, `marshal`, …
- **Dangerous calls:** `eval`, `exec`, `compile`, `open`, `__import__`,
  `globals`, `locals`, `setattr`, `delattr`, …
- **Sandbox-escape attributes:** `__subclasses__`, `__globals__`,
  `__builtins__`, `__class__`, `__code__`, …

`STRICT_MODE=true` flips to an **allow-list** instead. Extend either list with
`EXTRA_BLOCKED_MODULES` / `EXTRA_ALLOWED_MODULES`, or remove a built-in block
with `UNBLOCK_MODULES`.

## API

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/health` | – | status and limits |
| `POST` | `/api/run` | `{ code, stdin }` | one-shot result (JSON) |
| `POST` | `/api/runs` | `{ code, stdin?, mode }` | `{ runId }` — `mode`: script / repl / terminal |
| `GET` | `/api/runs/:id/events` | – | Server-Sent Events stream |
| `POST` | `/api/runs/:id/input` | `{ data }` | `{ ok }` |
| `POST` | `/api/runs/:id/kill` | – | `{ ok }` |
| `GET` | `/api/packages` | – | allowed package list |
| `POST` | `/api/packages` | `{ name }` | install result |

```bash
curl -s localhost:3000/api/run \
  -H 'Content-Type: application/json' \
  -d '{"code":"import math\nprint(math.pi)"}'
```

## Notes & limitations

- This is a personal tool, not a hardened multi-tenant service. The validator
  and resource limits raise the bar a lot; if you ever expose it publicly, also
  run the runner as a dedicated low-privilege user and consider a container or
  VM per execution.
- `os` and file access are blocked, so programs can't read or write files.
- Terminal mode is remote shell access. It is off by default; enable it only
  behind Cloudflare Access. It runs as the unprivileged service user inside the
  systemd sandbox, so it cannot use `sudo` or write outside the venv and `/tmp`.
- The deployment identifiers (`/opt/mobile-py-ide`, the `mobilepy` user and the
  `mobile-py-ide` systemd unit) keep their original names — only the visible
  product name changed to PyPad. Renaming them would mean migrating a live
  install for no benefit.
- CodeMirror is pulled from `esm.sh`; if you want a fully offline IDE, vendor it
  locally, or let the plain-textarea fallback take over.

## License

MIT — see [LICENSE](LICENSE).
