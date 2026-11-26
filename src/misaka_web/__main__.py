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

    args = parser.parse_args(argv)
    if args.command == "token":
        return _token(rotate=getattr(args, "rotate", False))
    return _serve(args)


def _token(*, rotate: bool) -> int:
    path = config.settings().token_file
    if rotate or not path.exists():
        config.write_token(config.generate_token())
        print(f"Wrote a new token to {path} (mode 0600).")
    else:
        print(f"Token already present at {path}; use --rotate to replace it.")
    return 0


def _serve(args: argparse.Namespace) -> int:
    import uvicorn

    settings = config.settings()
    host = args.host or settings.host
    port = args.port or settings.port
    if settings.host not in {"127.0.0.1", "localhost", "::1"} and not args.host:
        print("Warning: binding a non-loopback address directly; put TLS in front of it.", file=sys.stderr)
    uvicorn.run("misaka_web.api.app:app", host=host, port=port, log_level=getattr(args, "log_level", "info"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
