import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, open, readdir, rm, statfs } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const imageId = /^sha256:[a-f0-9]{64}$/;
const containerId = /^[a-f0-9]{64}$/;
const archiveLimit = 10 * 1024 ** 3;
const formatLimit = 16 * 1024 ** 2;
const archiveSeconds = 1800;
const oleMagic = Buffer.from("d0cf11e0a1b11ae1", "hex");
const status = {
  unavailable: 503, busy: 503, timeout: 504, memory_limit: 422, resource_limit: 413,
  failed: 422, output_missing: 422, invalid_request: 400, scratch_unavailable: 507,
};
const operations = new Map([
  ["/v1/archive", { name: "archive", imageEnv: "FACADE_ARCHIVE_IMAGE" }],
  ["/v1/doc", { name: "doc", imageEnv: "FACADE_OFFICE_IMAGE" }],
  ["/v1/xls", { name: "xls", imageEnv: "FACADE_OFFICE_IMAGE" }],
  ["/v1/dwg", { name: "dwg", imageEnv: "FACADE_DWG_IMAGE" }],
]);

class Rejected extends Error {}

function integer(value, max) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,10})$/.test(value) || Number(value) > max) {
    throw new Rejected("invalid_request");
  }
  return Number(value);
}

async function docker(...args) {
  const { stdout } = await exec("docker", args, {
    timeout: args[1] === "create" ? 25_000 : 10_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024,
  });
  return stdout.trim();
}

function absoluteEnv(key) {
  const path = process.env[key];
  if (!path || !isAbsolute(path) || /[,\r\n]/.test(path)) throw new Error(`${key} must be an absolute path`);
  return resolve(path);
}

const socketPath = absoluteEnv("FACADE_CONVERTER_SOCKET");
const scope = createHash("sha256").update(socketPath).digest("hex").slice(0, 24);
const label = `io.facade.converter-broker=${scope}`;
const scratch = join(absoluteEnv("FACADE_CONVERTER_SCRATCH"), `broker-${scope}`);
const images = Object.create(null);
const stopping = new AbortController();
let ready = false;
let occupied = false;

async function removeContainer(id) {
  if (!containerId.test(id)) throw new Error("Invalid container ID");
  await docker("container", "rm", "--force", "--volumes", id);
}

async function recover() {
  const pending = await docker("container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `label=${label}`);
  for (const id of pending.split("\n").filter(Boolean)) await removeContainer(id);
}

async function prepareScratch() {
  await mkdir(scratch, { mode: 0o700, recursive: true });
  const directory = await lstat(scratch);
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077)) {
    throw new Error("Broker scratch directory must be private");
  }
  for (const path of await readdir(scratch)) {
    if (/^job-[A-Za-z0-9]{6}$/.test(path)) await rm(join(scratch, path), { recursive: true, force: true });
  }
}

async function stage(input, target, size, operation, signal) {
  const handle = await open(target, "wx+", 0o600);
  let seen = 0;
  const abort = () => input.destroy();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of input.iterator({ destroyOnReturn: false })) {
      signal.throwIfAborted();
      seen += chunk.length;
      if (seen > size) throw new Rejected("invalid_request");
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Rejected("scratch_unavailable");
        offset += bytesWritten;
      }
    }
    if (seen !== size) throw new Rejected("invalid_request");
    if (operation !== "archive") {
      const magic = Buffer.alloc(8);
      const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
      const expected = operation === "dwg" ? /^AC10\d{2}$/.test(magic.toString("ascii", 0, 6)) : magic.equals(oleMagic);
      if (bytesRead < (operation === "dwg" ? 6 : 8) || !expected) throw new Rejected("invalid_request");
    }
    await handle.chmod(0o444);
  } finally {
    signal.removeEventListener("abort", abort);
    await handle.close();
  }
}

async function run(id, output, signal, maxOutput, archive) {
  const child = spawn("docker", ["container", "start", "--attach", id], {
    signal, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"],
  });
  child.on("error", () => {});
  const closed = new Promise(resolveClose => child.once("close", resolveClose));
  let size = 0;
  try {
    for await (const chunk of child.stdout) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > maxOutput) throw new Rejected("resource_limit");
      if (!output.write(chunk)) await once(output, "drain", { signal });
    }
    const exitCode = await closed;
    signal.throwIfAborted();
    const state = JSON.parse(await docker("container", "inspect", "--format", "{{json .State}}", id));
    if (state.OOMKilled) throw new Rejected("memory_limit");
    if (archive && state.ExitCode === 142) throw new Rejected("timeout");
    if (state.Status !== "exited" || state.Error) throw new Rejected("unavailable");
    if (state.ExitCode !== 0 || exitCode !== 0) throw new Rejected("failed");
    if (!size) throw new Rejected("output_missing");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}

function reply(output, result) {
  if (output.destroyed) return;
  if (output.headersSent) output.addTrailers({ "x-converter-result": result });
  else {
    output.removeHeader("trailer");
    output.removeHeader("content-type");
    output.writeHead(status[result], { "x-converter-result": result, "content-length": 0 });
  }
  output.end();
}

async function handle(input, output, expectContinue = false) {
  output.setHeader("connection", "close");
  const operation = operations.get(input.url);
  if (!ready) return reply(output, "unavailable");
  if (input.method === "GET" && input.url === "/v1/info") {
    return output.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(images));
  }
  if (input.method !== "POST" || !operation || input.httpVersion !== "1.1") return reply(output, "invalid_request");
  const { name } = operation;
  const image = images[name];
  if (!image || (name !== "archive" && input.headers["x-converter-image"] !== image)) {
    return reply(output, "unavailable");
  }

  const archive = name === "archive";
  let size, expanded, entries;
  try {
    size = integer(input.headers["content-length"], archive ? archiveLimit : formatLimit);
    if (archive) {
      expanded = integer(input.headers["x-expanded-bytes"], archiveLimit);
      entries = integer(input.headers["x-archive-entries"], 10_000);
    }
  } catch {
    return reply(output, "invalid_request");
  }
  if (occupied) return reply(output, "busy");
  occupied = true;

  let directory;
  let id;
  let creating = false;
  let result = "ok";
  const disconnected = new AbortController();
  output.once("close", () => disconnected.abort());
  const active = AbortSignal.any([disconnected.signal, stopping.signal]);
  const uploadDeadline = AbortSignal.timeout(archive ? 1_800_000 : 30_000);
  let runDeadline;
  try {
    const free = await statfs(scratch, { bigint: true });
    if (free.bavail * free.bsize < BigInt(size)) throw new Rejected("scratch_unavailable");
    directory = await mkdtemp(join(scratch, "job-"));
    const source = join(directory, "input");
    if (expectContinue) output.writeContinue();
    await stage(input, source, size, name, AbortSignal.any([active, uploadDeadline]));
    active.throwIfAborted();

    const destination = archive ? "/source" : `/original.${name}`;
    const memory = archive ? "1024m" : "512m";
    creating = true;
    id = await docker("container", "create", "--pull=never", "--init", "--network=none", "--read-only",
      "--cap-drop=ALL", "--security-opt=no-new-privileges=true", "--ipc=none", "--user=65534:65534",
      `--memory=${memory}`, `--memory-swap=${memory}`, `--cpus=${archive ? 2 : 1}`,
      `--pids-limit=${archive ? 12 : 64}`, "--log-driver=none", "--no-healthcheck",
      "--label", label, "--name", `facade-converter-${randomUUID()}`,
      "--mount", `type=bind,src=${source},dst=${destination},readonly`,
      ...(archive ? [] : ["--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=96m,mode=1777"]),
      image, ...(archive ? [String(expanded), String(entries), String(archiveSeconds)] : [name]));
    if (!containerId.test(id)) throw new Error("Invalid container ID");
    creating = false;
    output.setHeader("trailer", "x-converter-result");
    output.setHeader("content-type", "application/octet-stream");
    runDeadline = AbortSignal.timeout(archive ? archiveSeconds * 1000 + 3000 : 35_000);
    // The extractor limits actual expanded bytes; this caps the framed transport.
    const maxOutput = archive ? expanded + entries * 8256 + Math.ceil(expanded / 65_536) * 16 + 64 * 1024 ** 2 : formatLimit;
    await run(id, output, AbortSignal.any([runDeadline, active]), maxOutput, archive);
  } catch (error) {
    if (creating) {
      // The create outcome may be unknown; recovery must enumerate matching containers before serving again.
      ready = false;
      const cliStatus = error.killed ? "deadline" : Number.isInteger(error.code) ? `exit ${error.code}` : "unknown";
      console.error(`converter broker could not confirm container creation (${cliStatus}); restart required`);
    }
    if (error instanceof Rejected) result = error.message;
    else if (runDeadline?.aborted || uploadDeadline.aborted) result = "timeout";
    else if (error.code === "ENOSPC" || error.code === "EDQUOT") result = "scratch_unavailable";
    else result = "unavailable";
  } finally {
    try {
      if (id && containerId.test(id)) await removeContainer(id);
      if (directory) await rm(directory, { recursive: true, force: true });
    } catch {
      ready = false;
      result = "unavailable";
      console.error("converter broker cleanup failed; restart required");
    }
    occupied = false;
  }
  reply(output, result);
}

function dispatch(input, output, expectContinue = false) {
  handle(input, output, expectContinue).catch(() => output.destroy());
}

const server = createServer({ requestTimeout: 0, headersTimeout: 5000 }, dispatch);
server.setTimeout(5000, socket => {
  // Headers are short. Once admitted, the request and conversion have separate deadlines.
  socket.destroy();
});
server.on("request", (input) => input.socket.setTimeout(0));
server.on("checkContinue", (input, output) => {
  input.socket.setTimeout(0);
  dispatch(input, output, true);
});
server.maxConnections = 32;

try {
  for (const { name, imageEnv } of operations.values()) {
    const id = process.env[imageEnv];
    if (!id) continue;
    if (!imageId.test(id)) throw new Error(`${imageEnv} must contain an image ID`);
    images[name] = id;
  }
  if (!Object.values(images).length) throw new Error("Configure at least one converter image");
  for (const id of new Set(Object.values(images))) {
    if (await docker("image", "inspect", "--format", "{{.Id}}", id) !== id) throw new Error("Image unavailable");
  }
  const parent = await lstat(dirname(socketPath));
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o022)) {
    throw new Error("Socket parent must be owned by the broker and writable only by its owner");
  }
  process.umask(0o117); // The socket starts with mode 0660.
  server.listen(socketPath);
  await once(server, "listening");
  process.umask(0o077);
  await recover();
  await prepareScratch();
  ready = true;
  console.log("converter broker ready");
} catch {
  server.close();
  console.error("converter broker startup failed; check socket path, scratch ownership, images and local Docker");
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    ready = false;
    stopping.abort();
    server.close();
    server.closeAllConnections();
  });
}
