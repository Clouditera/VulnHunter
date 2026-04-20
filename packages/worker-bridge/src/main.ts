/**
 * VulnHunt Worker Bridge
 * Runs inside the worker container.
 * Bridges pi CLI stdio (--mode rpc) ↔ service HTTP/WS.
 */

const mode = process.env.MODE ?? "chat";
console.log(`Worker bridge starting in mode: ${mode}`);

// TODO: implement bridge
