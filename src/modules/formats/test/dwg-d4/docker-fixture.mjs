#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFileSync, closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";

const [resource, command, ...args] = process.argv.slice(2);
const image = process.env.FACADE_DWG_IMAGE;
const id = "7".repeat(64);
const state = process.env.FACADE_DWG_TEST_STATE;

process.on("uncaughtExceptionMonitor", (error) => appendFileSync(state + ".errors", error.stack + "\n"));

switch (`${resource} ${command}`) {
  case "image inspect":
    assert.deepEqual(args, ["--format", "{{.Id}}", image]);
    console.log(image);
    break;
  case "container ls":
    assert.ok(args.at(-1).startsWith("label=io.facade.converter-broker="));
    break;
  case "container create": {
    assert.deepEqual(args.slice(-2), [image, "dwg"]);
    assert.ok(args.includes("--network=none"));
    const mount = args[args.indexOf("--mount") + 1];
    const input = /^type=bind,src=(.+),dst=\/original\.dwg,readonly$/u.exec(mount)?.[1];
    assert.ok(input);
    const size = statSync(input).size;
    const file = openSync(input, "r");
    const prefix = Buffer.alloc(10);
    try {
      assert.equal(readSync(file, prefix), prefix.length);
    } finally {
      closeSync(file);
    }
    assert.equal(prefix.subarray(0, 6).toString(), "AC1015");
    const stdoutBytes = prefix.readUInt32LE(6);
    appendFileSync(state + ".log", JSON.stringify({ size, stdoutBytes }) + "\n");
    writeFileSync(state, String(stdoutBytes));
    console.log(id);
    break;
  }
  case "container start":
    assert.deepEqual(args, ["--attach", id]);
    process.stdout.write(Buffer.alloc(Number(readFileSync(state, "utf8")), 65));
    break;
  case "container inspect":
    assert.deepEqual(args, ["--format", "{{json .State}}", id]);
    console.log(JSON.stringify({ Status: "exited", ExitCode: 0, OOMKilled: false, Error: "" }));
    break;
  case "container rm":
    assert.deepEqual(args, ["--force", "--volumes", id]);
    break;
  default:
    throw new Error("Unexpected broker Docker command");
}
