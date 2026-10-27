// Lets the HQ worker in WSL reach Nightshift's Meterless Runtime, which listens on Windows loopback only
// (127.0.0.1:8088; hotspot mode opens just the phone desk on 8089). A plain TCP relay, bound to the WSL-facing
// adapter only (never 0.0.0.0), so nothing on the network gains access; every request still needs the runtime's token.
// Usage (Windows): node nightshift-bridge.mjs [listenHost] [listenPort]
import net from 'node:net';

const listenHost = process.argv[2] ?? '172.23.224.1';
const listenPort = Number(process.argv[3] ?? 18088);
const target = { host: '127.0.0.1', port: 8088 };

net
  .createServer((client) => {
    const upstream = net.connect(target);
    client.pipe(upstream);
    upstream.pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const s of [client, upstream]) {
      s.on('error', close);
      s.on('close', close);
    }
  })
  .listen(listenPort, listenHost, () => console.log(`nightshift bridge ${listenHost}:${listenPort} -> ${target.host}:${target.port}`));
