"""Show acknowledged direct openings per original and reader independently of extracted claims."""


def covered_documents(documents, frozen_lanes):
    rows = {}
    for reader, lanes in frozen_lanes.items():
        for document in documents:
            openings, catalogue = [], []
            for lane_id, lane in lanes.items():
                for receipt in lane["delivered"].values():
                    if receipt["status"] != "ok":
                        continue
                    call = receipt["call"]
                    ref = call.get("ref", "")
                    if not isinstance(ref, str):
                        continue
                    if call["op"] in ("read", "view") and ref.startswith(document + ":"):
                        openings.append({"lane": lane_id, "receipt": receipt["id"], "call": call})
                    elif ref == document or ref == "cad/" + document or ref.startswith("cad/" + document + "/"):
                        catalogue.append({"lane": lane_id, "receipt": receipt["id"], "call": call})
            state = "addressed_opening" if openings else "catalogue_only" if catalogue else "no_addressed_opening"
            rows[reader, document] = {"reader": reader, "document": document, "state": state,
                                      "openings": openings, "navigation": catalogue}
    return list(rows.values())
