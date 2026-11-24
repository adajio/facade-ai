// Synthetic container entrypoint for follow-up-limits.mjs.
import { readFileSync, writeFileSync } from "node:fs";

const marker = readFileSync("/original.dwg").toString();
if (marker === "AC1015!") {
  const held = [];
  // Fill committed pages until the converter cgroup reports OOMKilled.
  for (;;) held.push(Buffer.alloc(8 * 1024 ** 2, 0x42));
}
if (marker !== "AC1015.") process.exit(2);
writeFileSync("/out/derivative", "0\nSECTION\n2\nENTITIES\n0\nTEXT\n5\n1A\n1\nfixture recovered\n0\nENDSEC\n0\nEOF\n",
  { flag: "wx", mode: 0o444 });
