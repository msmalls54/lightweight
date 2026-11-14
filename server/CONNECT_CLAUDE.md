# Connect Claude to Lightweight (MCP over a tunnel)

The tunnel points at a **gateway on 127.0.0.1:3001**, never at the server on :3000. The gateway forwards only
`/mcp` (with the private access token) and the muscle-map widget's assets. The dashboard, `/set/*`, `/quiet`,
`/session/*`, `/replay`, `/voice/*`, `/events` and the inspector all return 404 through it.

1. Start the server as usual (it opens the gateway on :3001 and creates `LW_MCP_TOKEN` in the repo `.env` once):
   ```bash
   cd server && npm run dev
   ```
2. In a second terminal, open the tunnel:
   ```bash
   cd server && npm run tunnel
   ```
   It prints the public origin and the **connector URL** `https://<random>.trycloudflare.com/mcp?access_token=…`.
   Keep that URL private: anyone with it can call the tools.
3. Restart the server once (Ctrl-C, `npm run dev`) so the widget loads from the public origin
   (the origin is saved in `server/.cache/public-url.txt`; `LW_PUBLIC_URL` overrides it).
4. claude.ai → Settings → Connectors → **Add custom connector** → paste the connector URL → Add.
5. In a chat, enable the Lightweight connector and ask: *"Show my last set"*, *"Which rep did I cheat and which arm is weaker?"*,
   *"How's my workout so far?"*

Notes
- A quick tunnel gets a new random URL every time it starts: redo steps 3–4 after restarting the tunnel.
- Stop the tunnel (Ctrl-C) when you're done; the server keeps running locally.
- Rate limit through the gateway: 240 MCP requests/min and 1200 asset requests/min per caller IP.
