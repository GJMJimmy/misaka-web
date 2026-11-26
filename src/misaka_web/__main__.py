"""Command line: serve the bridge, or mint the single token it accepts."""

from __future__ import annotations

import argparse
import sys

from . import __version__, config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="misaka-web", description="Mobile-first web UI for MISAKA")
    parser.add_argument("--version", action="version", version=f"misaka-web {__version__}")
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="Run the HTTP bridge")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)
    serve.add_argument("--log-level", default="info")

    token = sub.add_parser("token", help="Create or show the token file")
    token.add_argument("--rotate", action="store_true", help="Replace the existing token")

    sub.add_parser("doctor", help="Check the token, the board, the UI build and the control sockets")

    args = parser.parse_args(argv)
    if args.command == "token":
        return _token(rotate=getattr(args, "rotate", False))
    if args.command == "doctor":
        from .doctor import main as doctor_main

        return doctor_main()
    return _serve(args)


def _token(*, rotate: bool) -> int:
    path = config.settings().token_file
    if rotate or not path.exists():
        config.write_token(config.generate_token())
        print(f"Wrote a new token to {path} (mode 0600).")
    else:
        print(f"Token already present at {path}; use --rotate to replace it.")
    return 0


LOOPBACK = {"127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"}


def _bind_warning(host: str) -> str | None:
    """Say plainly what a non-loopback bind costs, whichever way the address was chosen."""
    if host in LOOPBACK:
        return None
    return (
        f"Warning: binding {host}, which other machines can reach.\n"
        "  - the token and every request travel in cleartext unless TLS terminates in front;\n"
        "  - browsers treat a plain-HTTP LAN address as an insecure context, so the offline shell,\n"
        "    the clipboard button and notifications are unavailable (loopback and https are not);\n"
        "  - for an intranet test prefer keeping 127.0.0.1 and putting Caddy in front, even with tls internal."
    )


def _serve(args: argparse.Namespace) -> int:
    import uvicorn

    settings = config.settings()
    host = args.host or settings.host
    port = args.port or settings.port
    warning = _bind_warning(host)
    if warning:
        print(warning, file=sys.stderr)
    uvicorn.run("misaka_web.api.app:app", host=host, port=port, log_level=getattr(args, "log_level", "info"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())