// The PTY relay used for Terminal and REPL runs.
//
// It gives the child a real pseudoterminal, so it behaves exactly as it would
// in a terminal: prompts, line editing, arrow-key history, Ctrl+C, colours.
// Bytes are forwarded both ways unchanged.
//
// Using a pty also means cleanup is automatic: when this process dies the
// master side closes, the child sees EOF/SIGHUP and goes with it.

export const PTY_DRIVER = `import os, pty, select, struct, sys, fcntl, termios

cols = max(20, min(500, int(os.environ.get("PTY_COLS", "100"))))
rows = max(5, min(200, int(os.environ.get("PTY_ROWS", "30"))))

# Debian's /etc/bash.bashrc sets PS1 for every interactive shell, so the only
# way to get a short prompt is an --rcfile of our own, which bash reads last.
rc = None
try:
    rc = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bashrc")
    with open(rc, "w") as f:
        f.write("PS1='$ '\\n")
except Exception:
    rc = None

args = sys.argv[1:]
if rc and args and os.path.basename(args[0]) == "bash":
    args = [args[0], "--rcfile", rc] + args[1:]

pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(args[0], args)
    except Exception:
        os._exit(127)

try:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
except Exception:
    pass

stdin_fd = sys.stdin.fileno()
out = sys.stdout.buffer
watching_stdin = True

try:
    while True:
        watch = [fd]
        if watching_stdin:
            watch.append(stdin_fd)
        ready, _, _ = select.select(watch, [], [])
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            out.write(data)
            out.flush()
        if watching_stdin and stdin_fd in ready:
            data = os.read(stdin_fd, 65536)
            if not data:
                watching_stdin = False
                continue
            try:
                os.write(fd, data)
            except OSError:
                break
finally:
    try:
        os.close(fd)
    except Exception:
        pass
`;
