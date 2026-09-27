// scripts/emu-proxy.cjs — minimal HTTP/HTTPS (CONNECT) forward proxy for the Android emulator.
//
// Why (24.09.2026, docs/emulator-runbook.md): the AVD guest cannot resolve
// Cloudflare/AAAA hosts (`rpc.magicblock.app`, `devnet-router`) from inside apps,
// and wallets need `relayer-…railway.app` for Digital Asset Links within 1 s.
// Routing the guest through this proxy makes the Mac do the DNS. Logs one line
// per CONNECT/request so you can see which host an app/wallet is hitting.
//
// Run:  node scripts/emu-proxy.cjs   (listens on 127.0.0.1:8888; guest reaches it as 10.0.2.2:8888)
const http = require('http'); const net = require('net'); const { URL } = require('url');
const srv = http.createServer((req, res) => {
  try { const u = new URL(req.url); const p = http.request({ host: u.hostname, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); p.on('error', () => res.destroy()); req.pipe(p); } catch { res.destroy(); }
});
srv.on('connect', (req) => console.log(new Date().toISOString(), 'CONNECT', req.url));
srv.on('connect', (req, sock, head) => {
  const [host, port] = req.url.split(':'); const up = net.connect(Number(port) || 443, host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
});
srv.listen(8888, '127.0.0.1', () => console.log('proxy on 127.0.0.1:8888'));
