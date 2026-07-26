import {
  startTelegramCallbackServer,
} from "../../dist/authority/telegram-authority.js";

const [socketPath, socketGroupIdText] = process.argv.slice(2);
const socketGroupId = Number(socketGroupIdText);

if (!socketPath || !Number.isSafeInteger(socketGroupId)) {
  throw new Error("callback server arguments are invalid");
}

const server = await startTelegramCallbackServer({
  socketPath,
  socketGroupId,
  handle() {
    return {
      status: "invalid",
      message: "Host Bootstrap interface proof.",
    };
  },
});

async function stop() {
  await server.close();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
