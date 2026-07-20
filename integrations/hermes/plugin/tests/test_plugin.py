import importlib.util
import json
import socket
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


PLUGIN = Path(__file__).resolve().parents[1] / "__init__.py"
SPEC = importlib.util.spec_from_file_location("sompi_approval_plugin", PLUGIN)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class PluginTests(unittest.TestCase):
    def test_non_sompi_callback_is_unhandled(self):
        self.assertEqual(
            MODULE._on_gateway_callback_query(
                platform="telegram",
                callback_data="ea:once:1",
                user_id="1",
                chat_id="1",
            ),
            {"action": "unhandled"},
        )

    def test_exact_payload_is_relayed_over_unix_socket(self):
        with TemporaryDirectory() as directory:
            socket_path = str(Path(directory) / "callback.sock")
            received = []
            ready = threading.Event()

            def server():
                listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                listener.bind(socket_path)
                listener.listen(1)
                ready.set()
                connection, _ = listener.accept()
                request = b""
                while b"\r\n\r\n" not in request:
                    request += connection.recv(4096)
                headers, body = request.split(b"\r\n\r\n", 1)
                length = int(next(
                    line.split(b":", 1)[1].strip()
                    for line in headers.split(b"\r\n")
                    if line.lower().startswith(b"content-length:")
                ))
                while len(body) < length:
                    body += connection.recv(4096)
                received.append(json.loads(body[:length]))
                response = json.dumps({
                    "status": "approved",
                    "message": "Sompi Purchase approved.",
                }).encode()
                connection.sendall(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                    + f"Content-Length: {len(response)}\r\n\r\n".encode()
                    + response
                )
                connection.close()
                listener.close()

            thread = threading.Thread(target=server)
            thread.start()
            ready.wait(2)
            with patch.object(MODULE, "_load_settings", return_value=(socket_path, 2.0)):
                result = MODULE._on_gateway_callback_query(
                    platform="telegram",
                    callback_data="sp:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                    user_id="123",
                    chat_id="123",
                )
            thread.join(2)
            self.assertEqual(result, {
                "action": "handled",
                "status": "approved",
                "message": "Sompi Purchase approved.",
            })
            self.assertEqual(received, [{
                "profile": "sompi.telegram-authority-callback-v1",
                "callbackData": "sp:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "userId": "123",
                "chatId": "123",
            }])

    def test_relay_failure_is_handled_fail_closed(self):
        with patch.object(MODULE, "_relay", side_effect=OSError("unavailable")):
            result = MODULE._on_gateway_callback_query(
                platform="telegram",
                callback_data="sp:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
                user_id="123",
                chat_id="123",
            )
        self.assertEqual(result["action"], "handled")
        self.assertEqual(result["status"], "error")


if __name__ == "__main__":
    unittest.main()
