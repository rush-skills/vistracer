const privateRanges = [
  { start: "10.0.0.0", end: "10.255.255.255" },
  { start: "172.16.0.0", end: "172.31.255.255" },
  { start: "192.168.0.0", end: "192.168.255.255" },
  { start: "127.0.0.0", end: "127.255.255.255" }
];

function ipToLong(ip: string): number {
  return ip
    .split(".")
    .map((octet) => parseInt(octet, 10))
    .reduce((acc, value) => (acc << 8) + value, 0);
}

export function isPrivateIpv4(ipAddress: string | null): boolean {
  if (!ipAddress) {
    return false;
  }

  try {
    const ip = ipToLong(ipAddress);
    return privateRanges.some((range) => {
      const start = ipToLong(range.start);
      const end = ipToLong(range.end);
      return ip >= start && ip <= end;
    });
  } catch {
    return false;
  }
}
