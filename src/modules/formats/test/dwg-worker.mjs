import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const targetText = "AX-17 rev B | 2 x 35 mm | 70 mm";
const neighborText = "AX-17 rev C | 5 x 14 mm | 70 mm";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function toolMessage(name, args = {}) {
  return { choices: [{ finish_reason: "tool_calls", message: {
    role: "assistant", content: null,
    tool_calls: [{ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }],
  } }] };
}

export async function verifyOrdinaryDwg({
  db, config, load, projectId, scopeId, upload, seal, evidence,
}) {
  assert.ok(process.env.FACADE_CONVERTER_SOCKET, "connect the installed DWG converter");
  assert.notEqual(process.env.FACADE_GATEWAY_LIVE_MODE, "step-15", "use a managed synthetic gateway");
  const { createGateway, journalFromEnv } = await load("gateway/index.js");
  const { startWorker } = await load("harness/index.js");
  const journalConnection = journalFromEnv();
  assert.ok(journalConnection, "provision a dedicated journal using stand add-journal");
  const gateway = createGateway(db, { journal: journalConnection.journal });
  const driver = new AbortController();
  const providerErrors = [];
  const imageDigests = new Set();
  const warnings = new Set();
  const readVersions = new Set();
  let worker;
  let source;
  const provider = createServer(async (req, res) => {
    try {
      const { attempt, request } = await new Response(req).json();
      const assigned = JSON.parse(request.messages[1].content);
      assert.equal(assigned.place.source.sha256, source.sha256);
      assert.equal(assigned.place.source.versionId, source.versionId);
      readVersions.add(assigned.place.source.versionId);
      const replies = request.messages.filter(({ role }) => role === "tool").map(({ content }) => JSON.parse(content));
      let output;
      if (!replies.length) output = toolMessage("survey");
      else if (replies.length === 1) {
        const image = request.messages.flatMap(({ content }) => Array.isArray(content) ? content : [])
          .find(({ type }) => type === "image_url");
        assert.ok(image, "the actual survey PNG reached the synthetic receiver");
        const digest = sha256(Buffer.from(image.image_url.url.split(",")[1], "base64"));
        assert.equal(digest, replies[0].evidence.sha256);
        imageDigests.add(digest);
        output = toolMessage("extract");
      } else if (replies.length === 2) {
        const presented = replies[1];
        const { address, lines, limitations } = JSON.parse(presented.content);
        assert.ok(limitations.includes("cad_converted_handle_unverified"));
        if (address.locator.space === "Model") {
          const line = lines.find(({ text }) => text === targetText);
          assert.equal(line.locator.derivativeHandle, "2E");
          assert.ok(lines.some(({ text }) => text === neighborText));
          output = toolMessage("save_observation", {
            evidenceId: presented.evidence.evidenceId, lineId: line.id, quote: line.text,
            value: "70", unit: "mm", sourceRole: "design",
          });
        } else {
          assert.ok(lines.some(({ text }) => text === "Wing M: Sheet title"));
          output = toolMessage("finish_reading", { status: "no_match", explanation: "Paper checked." });
        }
      } else {
        assert.ok(replies[2].observationId, "the primary branch has persisted its observation");
        output = toolMessage("finish_reading", { status: "covered", explanation: "Model checked." });
      }
      res.end(JSON.stringify({ receipt: {
        state: "paid", providerId: `managed:${attempt.id}`, costUsdNanos: 0, evidenceRef: "replay:step11",
      }, output }));
    } catch (error) {
      providerErrors.push(error.message);
      res.statusCode = 500;
      res.end();
    }
  });
  const previousUrl = process.env.FACADE_HARNESS_MANAGED_URL;
  const previousProfile = process.env.FACADE_HARNESS_PROFILE;
  try {
    for (const [branch, purpose] of [["a", "primary_a"], ["b", "primary_b"]]) {
      const routeId = `managed-${branch}`;
      await gateway.configureRoute({ id: routeId, revision: "step11-replay", transport: "managed", enabled: true,
        maxRequestBytes: 16 * 1024 ** 2, ceilingUsdNanos: 1, timeoutMs: 25_000 });
      await gateway.grantRoute({ projectId, routeId, revision: "step11-replay", purpose,
        dataClass: "synthetic", allowed: true });
    }
    await new Promise((resolve, reject) => provider.listen(0, "127.0.0.1", resolve).once("error", reject));
    process.env.FACADE_HARNESS_MANAGED_URL = `http://127.0.0.1:${provider.address().port}/replay`;
    delete process.env.FACADE_HARNESS_PROFILE;
    source = await upload("schedule.dwg");
    await seal();
    worker = startWorker({ db, config, signal: driver.signal, logger: {
      info() {}, warn(message) { warnings.add(message); }, error(message) { warnings.add(message); },
    } });
    void worker.catch((error) => warnings.add(error.name));
    const stop = Date.now() + 120_000;
    let rows = [];
    let outcomes = [];
    while (Date.now() < stop && !providerErrors.length) {
      const result = await db.query(
        `SELECT a.branch, a.payload, j.dispatched_at
         FROM reader_observations a JOIN intake_reader_jobs j ON a.version_id=j.version_id
         WHERE a.project_id=$1 AND a.version_id=$2 AND a.scope_id=$3 ORDER BY a.branch`,
        [projectId, source.versionId, scopeId],
      );
      rows = result.rows;
      const obligations = await db.query(
        `SELECT p.branch, p.state FROM gateway_primary p JOIN gateway_generations g USING(generation_id)
         WHERE g.project_id=$1 AND g.scope_id=$2 AND g.current ORDER BY p.branch`, [projectId, scopeId],
      );
      outcomes = obligations.rows;
      if (rows.length === 2 && rows.every((row) => row.dispatched_at)
        && outcomes.length === 4 && outcomes.every(({ state }) => state === "completed")) break;
      await delay(250);
    }
    assert.deepEqual(providerErrors, []);
    assert.deepEqual(rows.map(({ branch }) => branch), ["A", "B"], [...warnings].join("; "));
    assert.deepEqual(outcomes.map(({ branch }) => branch), ["A", "A", "B", "B"]);
    assert.ok(outcomes.every(({ state }) => state === "completed"), JSON.stringify(outcomes));
    assert.deepEqual([...readVersions], [source.versionId]);
    assert.ok(imageDigests.size > 0);
    for (const { payload } of rows) {
      assert.equal(payload.source.sha256, source.sha256);
      assert.equal(payload.address.locator.derivativeHandle, "2E");
      assert.equal(payload.quote, targetText);
      assert.match((await evidence(payload.evidenceId)).body, /cad_converted_handle_unverified/);
    }
    const { rows: [projection] } = await db.query(
      `SELECT machine FROM assessment_question_revisions WHERE scope_id=$1 ORDER BY version DESC LIMIT 1`, [scopeId],
    );
    assert.equal(projection.machine.outcome, "covered");
    assert.deepEqual(
      projection.machine.citations.map(({ evidenceId }) => evidenceId).sort(),
      rows.map(({ payload }) => payload.evidenceId).sort(),
    );
    assert.equal((await journalConnection.journal.balance()).spentUsdNanos, 0);
  } finally {
    driver.abort();
    await Promise.allSettled([worker]);
    if (provider.listening) await new Promise((resolve) => provider.close(resolve));
    if (previousUrl === undefined) delete process.env.FACADE_HARNESS_MANAGED_URL;
    else process.env.FACADE_HARNESS_MANAGED_URL = previousUrl;
    if (previousProfile === undefined) delete process.env.FACADE_HARNESS_PROFILE;
    else process.env.FACADE_HARNESS_PROFILE = previousProfile;
    await journalConnection.close();
  }
}
