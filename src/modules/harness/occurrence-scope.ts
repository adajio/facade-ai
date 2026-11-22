// intake clears the live hold scopes when the reason closes. The last explicit
// assignment remains in that receipt's audit events.
export const occurrenceScopeJoin = `
  LEFT JOIN intake_uploads u ON u.occurrence_id=c.id
  LEFT JOIN intake_imports i ON i.id=c.import_id
  LEFT JOIN intake_holds h ON h.id=coalesce(u.hold_id,i.hold_id)
  LEFT JOIN LATERAL (
    SELECT ARRAY(SELECT jsonb_array_elements_text(e.data->'scopeIds'))::uuid[] AS scope_ids
    FROM intake_events e
    WHERE e.receipt_id=h.receipt_id AND e.project_id=h.project_id
      AND e.type IN ('intake.held','intake.hold_narrowed')
      AND coalesce(e.data->>'holdId',e.data->>'id')=h.id::text
      AND jsonb_typeof(e.data->'scopeIds')='array'
    ORDER BY e.id DESC LIMIT 1
  ) assignment ON h.scope_ids IS NULL`;

export const occurrenceScope = 'coalesce(h.scope_ids,assignment.scope_ids)';
