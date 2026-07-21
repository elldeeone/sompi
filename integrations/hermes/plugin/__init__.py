"""Least-authority Hermes bridge for Sompi Telegram approval callbacks."""

from __future__ import annotations

import http.client
import json
import socket
from pathlib import Path
from typing import Any


_CALLBACK_PROFILE = "sompi.telegram-authority-callback-v1"
_PREFIX = "sp:"
_MAX_RESPONSE_BYTES = 4096
_VALID_STATUSES = {
    "approved",
    "denied",
    "expired",
    "replayed",
    "unauthorized",
    "invalid",
}


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: float):
        super().__init__("localhost", timeout=timeout)
        self._socket_path = socket_path

    def connect(self) -> None:
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(self.timeout)
        connection.connect(self._socket_path)
        self.sock = connection


def _load_settings() -> tuple[str, float]:
    from hermes_cli.config import cfg_get, load_config

    config = load_config() or {}
    socket_path = cfg_get(
        config,
        "plugins",
        "entries",
        "sompi-approval",
        "callback_socket",
        default="",
    )
    timeout_ms = cfg_get(
        config,
        "plugins",
        "entries",
        "sompi-approval",
        "timeout_ms",
        default=2000,
    )
    if (
        not isinstance(socket_path, str)
        or not socket_path
        or not Path(socket_path).is_absolute()
        or str(Path(socket_path).resolve()) != socket_path
    ):
        raise ValueError("Sompi callback socket is not a canonical absolute path")
    if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or not 100 <= timeout_ms <= 5000:
        raise ValueError("Sompi callback timeout is invalid")
    return socket_path, timeout_ms / 1000


def _relay(payload: dict[str, str]) -> dict[str, str]:
    socket_path, timeout = _load_settings()
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    connection = _UnixHTTPConnection(socket_path, timeout)
    try:
        connection.request(
            "POST",
            "/callback",
            body=body,
            headers={
                "content-type": "application/json",
                "content-length": str(len(body)),
            },
        )
        response = connection.getresponse()
        declared = response.getheader("content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > _MAX_RESPONSE_BYTES):
            raise ValueError("Sompi callback response is too large")
        data = response.read(_MAX_RESPONSE_BYTES + 1)
        if len(data) > _MAX_RESPONSE_BYTES:
            raise ValueError("Sompi callback response is too large")
        value = json.loads(data.decode("utf-8"))
        if (
            not isinstance(value, dict)
            or set(value) != {"status", "message"}
            or value.get("status") not in _VALID_STATUSES
            or not isinstance(value.get("message"), str)
            or not 1 <= len(value["message"]) <= 200
            or response.status not in {200, 409}
        ):
            raise ValueError("Sompi callback response is invalid")
        return {"status": value["status"], "message": value["message"]}
    finally:
        body = b""
        connection.close()


def _on_gateway_callback_query(
    platform: str = "",
    callback_data: str = "",
    user_id: str = "",
    chat_id: str = "",
    **_: Any,
) -> dict[str, str]:
    if platform != "telegram" or not callback_data.startswith(_PREFIX):
        return {"action": "unhandled"}
    if (
        not isinstance(callback_data, str)
        or len(callback_data) > 64
        or not isinstance(user_id, str)
        or not user_id.isdigit()
        or not isinstance(chat_id, str)
        or not chat_id.lstrip("-").isdigit()
    ):
        return {
            "action": "handled",
            "status": "invalid",
            "message": "This Sompi button is invalid or expired.",
        }
    try:
        result = _relay({
            "profile": _CALLBACK_PROFILE,
            "callbackData": callback_data,
            "userId": user_id,
            "chatId": chat_id,
        })
    except Exception:
        return {
            "action": "handled",
            "status": "error",
            "message": "Couldn't confirm your choice safely. Nothing was approved.",
        }
    return {"action": "handled", **result}


def register(ctx) -> None:
    ctx.register_hook("gateway_callback_query", _on_gateway_callback_query)
