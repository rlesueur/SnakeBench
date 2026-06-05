import { WebSocket } from "ws";

/**
 * Throwaway load-test client: opens N agent connections (each becomes its own
 * snake) so we can watch the arena grow the play-area as players join.
 *
 * Usage: node scripts/loadtest.mjs [count] [key] [arenaUrl]
 */
const COUNT = Number(process.argv[2] ?? 16);
const KEY = process.argv[3] ?? "local-dev-key";
const ARENA = process.argv[4] ?? "ws://localhost:8080";

const DELTA = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPP = { up: "down", down: "up", left: "right", right: "left" };
const DIRS = ["up", "down", "left", "right"];

let lastWorld = "";
let alive = 0;

function connectOne(idx) {
  const ws = new WebSocket(`${ARENA}/agent`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  let keepalive;
  ws.on("open", () => {
    alive += 1;
    // Queued (between-round) clients receive no state, so ping to dodge the
    // server idle-timeout until the next round includes them.
    keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, 5000);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "round_start") {
      const w = `${msg.world.width}x${msg.world.height}`;
      if (idx === 0 && w !== lastWorld) {
        lastWorld = w;
        console.log(`round ${msg.round}: world ${w}  (connected clients: ${alive})`);
      }
      return;
    }
    if (msg.type !== "state") return;
    const s = msg.state;
    const h = s.you.head;
    const blocked = new Set();
    for (const c of s.you.body) blocked.add(`${c.x},${c.y}`);
    for (const sn of s.snakes) for (const c of sn.body) blocked.add(`${c.x},${c.y}`);
    for (const o of s.obstacles ?? []) blocked.add(`${o.x},${o.y}`);
    const banned = s.you.body.length > 1 ? OPP[s.you.heading] : null;
    const safe = DIRS.filter((d) => {
      if (d === banned) return false;
      const nx = h.x + DELTA[d][0];
      const ny = h.y + DELTA[d][1];
      if (nx < 0 || ny < 0 || nx >= s.world.width || ny >= s.world.height) return false;
      return !blocked.has(`${nx},${ny}`);
    });
    const move = safe.length ? safe[Math.floor(Math.random() * safe.length)] : s.you.heading;
    ws.send(JSON.stringify({ type: "action", tick: s.tick, move }));
  });
  ws.on("close", () => {
    alive -= 1;
    clearInterval(keepalive);
  });
  ws.on("error", (e) => console.error(`client ${idx} error:`, e.message));
}

console.log(`Connecting ${COUNT} clients with key "${KEY}" to ${ARENA} ...`);
for (let i = 0; i < COUNT; i++) setTimeout(() => connectOne(i), i * 20);
