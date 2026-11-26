"""Single-user bearer/cookie auth over a token file."""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Request, Response

from . import config

COOKIE_NAME = "mw_session"


def current_token() -> str:
    token = config.read_token()
    if not token:
        raise HTTPException(status_code=503, detail="No token configured; run: misaka-web token")
    return token


def token_matches(candidate: str | None) -> bool:
    if not candidate:
        return False
    return hmac.compare_digest(candidate.strip(), current_token())


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return None


def authenticated(request: Request) -> bool:
    candidate = _bearer(request) or request.cookies.get(COOKIE_NAME)
    try:
        return token_matches(candidate)
    except HTTPException:
        return False


async def require_auth(request: Request) -> None:
    if not authenticated(request):
        raise HTTPException(status_code=401, detail="Not authenticated")


def set_cookie(response: Response, token: str, *, secure: bool) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        samesite="strict",
        secure=secure,
        max_age=60 * 60 * 24 * 30,
        path="/",
    )


def clear_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")
