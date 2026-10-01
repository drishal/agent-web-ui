// This machine's LAN-facing names, for HOST=0.0.0.0 mode: non-internal
// interface addresses plus the hostname. Re-sampled every 30 s so DHCP or
// Wi-Fi changes are picked up without a restart.
import { hostname, networkInterfaces } from "node:os";

const TTL_MS = 30_000;

export function sampleLanHosts(): { hosts: Set<string>; ipv4: string[] } {
  const hosts = new Set<string>();
  const ipv4: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal) continue;
      if (a.family === "IPv4") {
        hosts.add(a.address);
        ipv4.push(a.address);
      } else {
        hosts.add(`[${a.address.split("%")[0]?.toLowerCase()}]`);
      }
    }
  }
  const name = hostname().toLowerCase();
  if (name) {
    hosts.add(name);
    hosts.add(`${name}.local`);
  }
  return { hosts, ipv4 };
}

export function cachedLanHosts(): () => Set<string> {
  let at = 0;
  let hosts = new Set<string>();
  return () => {
    if (Date.now() - at > TTL_MS) {
      hosts = sampleLanHosts().hosts;
      at = Date.now();
    }
    return hosts;
  };
}
