import crypto from 'node:crypto';
import readline from 'node:readline';
import bcrypt from 'bcryptjs';
import { newAgentToken, sha256 } from './auth.js';
import { pool, q1 } from './db.js';
import { migrate } from './migrate.js';

// Usage: create-founder --email you@example.com --name "Your Name" [--prompt | --password <pw>] [--reset]
// Without --prompt/--password a random password is generated and printed once. --reset changes an existing user's password.
function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const w = (rl as any)._writeToOutput;
    (rl as any)._writeToOutput = (s: string) => { if (s.includes(label)) w.call(rl, s); };
    rl.question(label, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

const email = arg('email')?.trim().toLowerCase();
const name = arg('name')?.trim();
if (!email || !name || /\s/.test(email)) {
  console.error('usage: create-founder --email <email> --name <name> [--prompt | --password <pw>] [--reset]');
  process.exit(2);
}

let password = arg('password');
let generated = false;
if (flag('prompt')) {
  password = await promptHidden('Password (min 12 chars): ');
  if (password !== (await promptHidden('Repeat password: '))) { console.error('passwords do not match'); process.exit(2); }
} else if (!password) {
  password = crypto.randomBytes(18).toString('base64url');
  generated = true;
}
if (password.length < 12) { console.error('password must be at least 12 characters'); process.exit(2); }

await migrate();
const hash = await bcrypt.hash(password, 12);
const existing = await q1('select id, role from users where email = $1', [email]);
if (existing && !flag('reset')) {
  console.error(`user ${email} already exists; pass --reset to change the password`);
  await pool.end();
  process.exit(1);
}
if (existing) {
  await pool.query('update users set password_hash = $2, name = $3 where id = $1', [existing.id, hash, name]);
} else {
  const u = await q1(`insert into users (name, email, password_hash, role) values ($1,$2,$3,'founder') returning id`, [name, email, hash]);
  // The agent runs inside the backend; its token is only for optional external workers and is not shown.
  await pool.query('insert into agents (name, role, user_id, token_hash) values ($1,$2,$3,$4)', [`${name} Agent`, 'founder', u!.id, sha256(newAgentToken())]);
}
console.log(`${existing ? 'Updated' : 'Created'} founder ${email}`);
if (generated) console.log(`Password (shown once, change it after first login): ${password}`);
await pool.end();
