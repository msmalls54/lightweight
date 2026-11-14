// Bench tool: tiny HTTP server for the hotspot test. Run: node bench/ping_server.mjs
// Prints this laptop's IPv4 addresses (put the hotspot one in LAPTOP_IP) and logs each UNO ping.
import http from "node:http";
import os from "node:os";

const PORT = 3000;
for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
  for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) console.log(`laptop ip ${a.address}  (${name})`);
}
http.createServer((req, res) => {
  console.log(`${new Date().toLocaleTimeString()} ping from ${req.socket.remoteAddress} ${req.url}`);
  res.writeHead(200, { "Content-Type": "text/plain" }).end("pong\n");
}).listen(PORT, "0.0.0.0", () => console.log(`listening on :${PORT}, waiting for the UNO...`));
