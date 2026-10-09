// The source used for REPL (interactive Python) mode.
//
// Python's `code` module gives us a real interactive interpreter over pipes.
// We subclass it only to send the `>>> ` prompts to stdout instead of stderr,
// so the browser console shows them in the normal colour.

export const REPL_SOURCE = `import code as _code
import sys as _sys

class _Console(_code.InteractiveConsole):
    def write(self, data):
        _sys.stdout.write(data)
        _sys.stdout.flush()

_console = _Console({"__name__": "__main__"})
try:
    _console.interact(banner="", exitmsg="")
except SystemExit:
    pass
`;

export const MODES = ['script', 'repl', 'terminal'];
