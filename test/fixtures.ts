// Test-only fixture: founder/pm/developer users (+agents) and one project. Never shipped in the image.
import bcrypt from 'bcryptjs';
import { newAgentToken, sha256 } from '../src/auth.js';
import { pool, q1 } from '../src/db.js';

const PASSWORD = 'Passw0rd!';
const PEOPLE = [
  { role: 'founder', name: 'Founder', email: 'founder@studio.local' },
  { role: 'pm', name: 'Project Manager', email: 'pm@studio.local' },
  { role: 'developer', name: 'Developer', email: 'dev@studio.local' },
] as const;

// Returns agent tokens by role (tokens are not recoverable later).
export async function seed(): Promise<{ tokens: Record<string, string>; projectId: string }> {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const tokens: Record<string, string> = {};
  const project = await q1(`insert into projects (name, description, repo_url, default_branch) values ('Visitca', 'Test project', '', 'main') returning id`);
  for (const p of PEOPLE) {
    const u = await q1('insert into users (name, email, password_hash, role) values ($1,$2,$3,$4) returning id', [p.name, p.email, hash, p.role]);
    await pool.query('insert into project_members (project_id, user_id) values ($1,$2)', [project!.id, u!.id]);
    const token = newAgentToken();
    await pool.query('insert into agents (name, role, user_id, token_hash) values ($1,$2,$3,$4)', [`${p.name} Agent`, p.role, u!.id, sha256(token)]);
    tokens[p.role] = token;
  }
  return { tokens, projectId: project!.id };
}
