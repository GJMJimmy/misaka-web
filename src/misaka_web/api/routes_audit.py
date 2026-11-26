"""The write actions this bridge performed, for a phone to check after the fact."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from .. import auth
from ..bridge import audit_log

router = APIRouter(prefix="/api/audit", tags=["audit"], dependencies=[Depends(auth.require_auth)])


@router.get("")
async def read_audit(limit: int = 100, action: str | None = None) -> dict[str, Any]:
    return audit_log.tail(limit=limit, action=action)
