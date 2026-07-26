import fs from "node:fs";
import net from "node:net";

const [socketPath, ownerUserIdText, ownerGroupIdText] = process.argv.slice(2);
const ownerUserId = Number(ownerUserIdText);
const ownerGroupId = Number(ownerGroupIdText);

if (
  !socketPath ||
  !Number.isSafeInteger(ownerUserId) ||
  !Number.isSafeInteger(ownerGroupId)
) {
  throw new Error("socket server arguments are invalid");
}

fs.rmSync(socketPath, { force: true });
const server = net.createServer((socket) => {
  socket.on("error", () => undefined);
  socket.end();
});

server.listen(socketPath, () => {
  const stat = fs.lstatSync(socketPath);
  if (stat.uid !== ownerUserId) {
    throw new Error("socket server did not run as the declared principal");
  }
  if (stat.gid !== ownerGroupId) {
    fs.chownSync(socketPath, -1, ownerGroupId);
  }
  fs.chmodSync(socketPath, 0o660);
});

function stop() {
  server.close(() => {
    fs.rmSync(socketPath, { force: true });
    process.exit(0);
  });
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
