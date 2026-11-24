import { exactDeliveryStatement } from "../../domain/delivery-statement.js";
import type { PackageFact } from "../harness/package-analysis.js";
import { verifiedNativeLineCrops } from "../pdf/native-line.js";
import type { Evidence, ReaderLine } from "../pdf/types.js";
import { canonicalJson, type Citation } from "./domain.js";

export type DeliveryEvidence = Pick<Evidence, "source" | "address" | "representation" | "readerVersion" | "runId" |
  "branch" | "format" | "mediaType" | "limitations" | "receiptId">;

type DeliveryFact = Pick<PackageFact, "observation" | "basis">;

export function deliveryEvidenceIds(basis: DeliveryFact["basis"]) {
  return basis.deliveryLine?.crops?.map(({ evidenceId }) => evidenceId) ?? [];
}

export function fullDeliveryLine(fact: DeliveryFact, format: string, evidence: ReadonlyMap<string, DeliveryEvidence>,
  issuedLine: ReaderLine | undefined): { line: ReaderLine; identity?: string; companion?: Citation["deliveryBasis"] } | undefined {
  const { observation, basis } = fact;
  const claim = observation.deliveryStatement;
  if (!issuedLine || !claim || observation.grounding !== "text" || issuedLine.id !== observation.lineId ||
      !observation.quote || !issuedLine.text.includes(observation.quote)) return;
  if (!/^(?:application\/|\.)?pdf$/iu.test(format) && evidence.get(observation.evidenceId)?.format !== "pdf") return { line: issuedLine };

  const { source, address, evidenceId, readerVersion, runId, branch, receiptId } = observation;
  const native = (id: string) => {
    const stored = evidence.get(id);
    return stored?.format === "pdf" && stored.representation === "native" && stored.mediaType === "application/json" &&
      !stored.limitations?.length && stored.readerVersion === readerVersion && stored.runId === runId && stored.branch === branch &&
      stored.receiptId === receiptId && canonicalJson(stored.source) === canonicalJson(source) &&
      stored.address.unitId === address.unitId && stored.address.locator?.page === address.locator?.page &&
      stored.address.locator?.rotation === address.locator?.rotation ? stored : undefined;
  };
  const anchor = native(evidenceId);
  if (!anchor) return;
  const identity = ({ id, text, box }: ReaderLine) => canonicalJson([address.unitId, id, text, box]);
  const proof = basis.deliveryLine;
  // Observation.address.box locates the quote. Evidence.address.box locates the frame that was read.
  if (!proof) return anchor.address.box ? undefined : { line: issuedLine, identity: identity(issuedLine) };
  if (typeof proof.text !== "string" || !/^[0-9a-f]{64}$/u.test(proof.canonicalSha256) || proof.lineId !== issuedLine.id ||
      canonicalJson(proof.source) !== canonicalJson(source) || proof.runId !== runId || proof.branch !== branch ||
      proof.readerVersion !== readerVersion || proof.unitId !== address.unitId || proof.anchorEvidenceId !== evidenceId ||
      !Array.isArray(proof.crops) || proof.crops.length < 1 || proof.crops.length > 2) return;
  const crops = proof.crops.flatMap((crop) => {
    const stored = native(crop.evidenceId);
    if (!stored?.address.box || canonicalJson(stored.address.box) !== canonicalJson(crop.frame) || typeof crop.text !== "string") return [];
    return [{ evidenceId: crop.evidenceId, frame: crop.frame, line: { id: proof.lineId, text: crop.text, box: crop.box } }];
  });
  const line = { id: proof.lineId, text: proof.text, box: proof.box };
  const checked = verifiedNativeLineCrops(line, crops, proof.submittedEvidenceId, observation.quote);
  if (crops.length !== proof.crops.length || !checked || checked.crops.length !== crops.length ||
      checked.anchorEvidenceId !== evidenceId || !crops.some((crop) => crop.evidenceId === evidenceId &&
        crop.line.text === issuedLine.text && canonicalJson(crop.line.box) === canonicalJson(issuedLine.box))) return;
  if (exactDeliveryStatement(observation.quote, claim.item, "not_delivered")) return { line, identity: identity(line) };
  const context = claim.context;
  if (!context || context.lineId !== line.id || !exactDeliveryStatement(context.quote, claim.item, "not_delivered")) return;
  const support = checked.crops.find(({ line: crop }) => crop.text.includes(context.quote));
  const stored = support && native(support.evidenceId);
  if (!support || !stored) return;
  return { line, identity: identity(line), companion: { evidenceId: support.evidenceId,
    address: { ...stored.address, box: support.line.box }, quote: context.quote, href: `/api/v1/evidence/${support.evidenceId}` } };
}
