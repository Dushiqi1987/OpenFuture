import { networkInterfaces } from 'node:os'

/**
 * 手机能访问的本机地址排行。
 *
 * 一台机器通常同时有 Wi-Fi、VMware/Hyper-V 虚拟网卡、Tailscale 等地址，
 * 直接取第一个经常拿到手机根本连不上的虚拟网卡。这里按网卡名和网段打分：
 * - 名字像 Wi-Fi/以太网的加分
 * - 名字像虚拟网卡/隧道/容器的减分
 * - 家用/办公常见网段（192.168、10、172.16-31）加分
 */
function score(name: string, address: string): number {
  const n = name.toLowerCase()
  let value = 0

  if (/vmware|virtual|vbox|hyper-v|vethernet|docker|wsl|tailscale|zerotier|tun|tap|wintun|loopback/.test(n)) value -= 100
  if (/wlan|wi-fi|wifi|wireless/.test(n)) value += 60
  else if (/ethernet|eth|en\d|lan/.test(n)) value += 40

  if (address.startsWith('192.168.')) value += 20
  else if (address.startsWith('10.')) value += 10
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) value += 8

  return value
}

/** 去掉回环、链路本地地址，并按“手机最可能连得上”的顺序返回。 */
export function lanAddresses(): string[] {
  const seen = new Set<string>()
  const scored: Array<{ address: string; score: number }> = []

  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.') || entry.address === '0.0.0.0') continue
      if (seen.has(entry.address)) continue
      seen.add(entry.address)
      scored.push({ address: entry.address, score: score(name, entry.address) })
    }
  }

  return scored.sort((a, b) => b.score - a.score).map((item) => item.address)
}

/** 手机最可能连得上的那一个；没有局域网地址时返回 null。 */
export function firstLanIp(): string | null {
  return lanAddresses()[0] ?? null
}
