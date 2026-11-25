import type { Pool } from 'pg';
import { customerScope, type CustomerAccess } from '../gateway/admission.js';
import type { PostgresIntentJournal } from '../gateway/index.js';

export type CustomerRouteGrant = {
  routeId: string;
  revision: string;
  purpose: 'primary_a' | 'primary_b' | 'review';
  access: CustomerAccess;
};

export async function provisionCustomerProjects(
  db: Pool, journal: PostgresIntentJournal, defaults: readonly CustomerRouteGrant[],
) {
  const { rows: projects } = await db.query<{ id: string }>('SELECT id FROM projects WHERE intake_mode');
  const grants = projects.flatMap(({ id }) => defaults
    .filter(({ access }) => customerScope(access, id, null))
    .map(({ routeId, revision, purpose }) => ({ project_id: id, route_id: routeId, revision, purpose })));
  if (!grants.length) return;

  // The journal must have a committed limit before a project becomes dispatchable.
  await journal.ensureProjectBudgets([...new Set(grants.map(({ project_id }) => project_id))]);
  await db.query(
    `INSERT INTO gateway_grants(project_id,route_id,data_class,purpose,revision,allowed)
     SELECT p.id,r.id,'customer',g.purpose,r.revision,true
     FROM jsonb_to_recordset($1::jsonb) g(project_id uuid,route_id text,revision text,purpose text)
     JOIN projects p ON p.id=g.project_id AND p.intake_mode
     JOIN gateway_routes r ON r.id=g.route_id AND r.revision=g.revision AND r.enabled
     WHERE NOT EXISTS (
       SELECT 1 FROM gateway_grants existing WHERE existing.project_id=p.id AND existing.route_id=r.id
         AND existing.data_class='customer' AND existing.purpose=g.purpose
     )
     ON CONFLICT(project_id,route_id,data_class,purpose) DO NOTHING`,
    [JSON.stringify(grants)],
  );
}
