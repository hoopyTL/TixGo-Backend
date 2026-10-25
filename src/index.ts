import { app } from "./app";
import { db } from "./configs/db";
import { closeReservationCache } from "./configs/redis";

const PORT = Number(process.env.PORT || 3000);

const server = app.listen(PORT, () => {
  console.log(`TixGo listening at http://localhost:${PORT}`);
});

function stop() {
  const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 15000);
  deadline.unref();
  server.close(async () => {
    await closeReservationCache();
    await db.$disconnect();
    clearTimeout(deadline);
  });
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
