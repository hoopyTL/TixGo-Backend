import { createClient } from "redis";

let client: ReturnType<typeof createClient> | undefined;
let connecting: Promise<unknown> | undefined;
let lastWarning = 0;
let nextConnect = 0;

function warn() {
  if (Date.now() - lastWarning > 10000) {
    lastWarning = Date.now();
    console.warn(JSON.stringify({ event: "reservation_cache_unavailable", source: "postgresql" }));
  }
}

async function cache() {
  if (!process.env.REDIS_URL) return undefined;
  if (!client) {
    if (Date.now() < nextConnect) return undefined;
    client = createClient({
      url: process.env.REDIS_URL,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 100,
      socket: { connectTimeout: 200, reconnectStrategy: false },
    });
    client.on("error", warn);
  }
  const connection = client;
  if (connection.isReady) return connection;
  if (!connecting && Date.now() >= nextConnect) {
    nextConnect = Date.now() + 1000;
    const pending = connection.connect().catch(warn).finally(() => {
      if (connecting === pending) connecting = undefined;
    });
    connecting = pending;
  }
  if (connecting) await connecting;
  return connection.isReady ? connection : undefined;
}

export async function updateReservationCache(reservation: { id: string; status: string; expiresAt: Date }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = cache();
  const connection = client;
  try {
    const operation = ready.then(async (active) => {
      if (!active) return;
      const command = active.withCommandOptions({ timeout: 200 });
      const key = `reservation:${reservation.id}`;
      if (reservation.status === "HELD" && reservation.expiresAt.getTime() > Date.now()) {
        await command.set(key, JSON.stringify({ status: reservation.status, expiresAt: reservation.expiresAt }),
          { expiration: { type: "PXAT", value: reservation.expiresAt.getTime() } });
      } else await command.del(key);
    });
    // node-redis queue timeout does not bound waiting for a reply to an already-sent command.
    await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (connection?.isOpen) connection.destroy();
        if (client === connection) {
          client = undefined;
          nextConnect = Date.now() + 1000;
        }
        reject(new Error("Reservation cache deadline exceeded"));
      }, 250);
    })]);
  } catch {
    // Cache failure cannot reverse a committed PostgreSQL operation.
    warn();
  } finally { if (timer) clearTimeout(timer); }
}

export async function closeReservationCache() {
  if (connecting) await connecting;
  if (client?.isOpen) client.destroy();
  client = undefined;
  nextConnect = 0;
}
