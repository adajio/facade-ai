#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, closeSync, openSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [resource, command, ...args] = process.argv.slice(2);
const odaLauncher = "--entrypoint=/usr/local/bin/facade-oda-convert";
const image = process.env.FACADE_DWG_IMAGE;
const id = "7".repeat(64);
const state = process.env.FACADE_DWG_TEST_STATE;
const failures = { d: 73, o: 137, u: 69, r: 74 };

process.on("uncaughtExceptionMonitor", (error) => appendFileSync(state + ".errors", error.stack + "\n"));

const header = "0\nSECTION\n2\nHEADER\n";
const drawing = "0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nTEXT\n5\nAFF\n1\nDWG test | 23 mm\n10\n0\n20\n1\n0\nENDSEC\n0\nEOF\n";

function derivative(file, size) {
  const fd = openSync(file, "wx");
  try {
    writeSync(fd, header);
    let padding = size - header.length - drawing.length;
    if (padding) {
      assert.ok(padding >= 5);
      const line = "999\n" + ".".repeat(1000) + "\n";
      while (padding >= line.length + 5) {
        writeSync(fd, line);
        padding -= line.length;
      }
      writeSync(fd, "999\n" + ".".repeat(padding - 5) + "\n");
    }
    writeSync(fd, drawing);
  } finally {
    closeSync(fd);
  }
}

switch (`${resource} ${command}`) {
  case "run --rm":
    assert.deepEqual(args.slice(-2), [image, "oda-probe"]);
    assert.ok(args.includes("--platform=linux/amd64"));
    assert.ok(args.includes(odaLauncher));
    console.log(process.env.FACADE_ODA_BINARY_SHA256);
    console.log(process.env.FACADE_ODA_TEST_RUNTIME_HASH);
    break;
  case "container ls":
    assert.ok(args.at(-1).startsWith("label=io.facade.converter-broker="));
    break;
  case "container create": {
    assert.deepEqual(args.slice(-2), [image, "dwg"]);
    assert.ok(args.includes("--network=none"));
    assert.ok(args.includes("--memory=1536m"));
    assert.ok(args.includes("--platform=linux/amd64"));
    assert.ok(args.includes(odaLauncher));
    assert.ok(args.includes(`type=bind,src=${process.env.FACADE_ODA_ROOT},dst=/oda,readonly`));
    assert.ok(args.includes(`type=bind,src=${process.env.FACADE_ODA_RUNTIME},dst=/deps,readonly`));
    const input = args.map(arg => /^type=bind,src=(.+),dst=\/input\/original\.dwg,readonly$/u.exec(arg)?.[1]).find(Boolean);
    const out = args.map(arg => /^type=bind,src=(.+),dst=\/out$/u.exec(arg)?.[1]).find(Boolean);
    assert.ok(input && out);
    assert.equal(statSync(out).mode & 0o777, 0o733);
    const budget = BigInt(args.find(arg => arg.startsWith("FACADE_DWG_OUTPUT_BUDGET=")).split("=")[1]);
    assert.ok(budget > 0);
    assert.ok(args.includes(`fsize=${budget}:${budget}`));
    const size = statSync(input).size;
    const file = openSync(input, "r");
    const prefix = Buffer.alloc(11);
    try {
      assert.equal(readSync(file, prefix), prefix.length);
    } finally {
      closeSync(file);
    }
    assert.equal(prefix.subarray(0, 6).toString(), "AC1015");
    const outputSize = prefix.readUInt32LE(6);
    const mode = String.fromCharCode(prefix[10]);
    const job = { size, outputSize, mode, out };
    appendFileSync(state + ".log", JSON.stringify(job) + "\n");
    writeFileSync(state, JSON.stringify(job));
    console.log(id);
    break;
  }
  case "container start": {
    assert.deepEqual(args, ["--attach", id]);
    const { out, mode, outputSize } = JSON.parse(readFileSync(state));
    if (mode === "s") await delay(20_000);
    if (mode in failures) process.exit(failures[mode]);
    if (mode === "m") break;
    const file = join(out, "derivative");
    if (mode === "t") writeFileSync(file, "0\nSECTION\n2\nENTITIES\n");
    else if (mode === "j") writeFileSync(file, '{"OBJECTS":[]}');
    else derivative(file, outputSize);
    chmodSync(file, 0o444);
    break;
  }
  case "container inspect": {
    assert.deepEqual(args, ["--format", "{{json .State}}", id]);
    const { mode } = JSON.parse(readFileSync(state));
    console.log(JSON.stringify({ Status: "exited", ExitCode: failures[mode] ?? 0, OOMKilled: mode === "o", Error: "" }));
    break;
  }
  case "container rm":
    assert.deepEqual(args, ["--force", "--volumes", id]);
    break;
  default:
    throw new Error("Unexpected broker Docker command");
}
