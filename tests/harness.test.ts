import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('src/harness.ts');
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-ts-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const fake = join(bin, 'codex');
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const text = prompt.startsWith('Extract only durable') ? '["Always cite the original source"]' : 'Mock answer: ' + prompt.split('YOUR STEP (').pop().split(')')[0];
if (process.env.FAIL_FAKE === '1') { console.log(JSON.stringify({type:'turn.failed'})); process.exit(0); }
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], text);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed'}));
`);
  chmodSync(fake, 0o755);
  const state = join(dir, 'state');
  const env = { ...process.env, HARNESS_HOME: state, PATH: bin + ':' + process.env.PATH };
  const run = (args: string[], extraEnv: Record<string, string> = {}) => spawnSync(process.execPath,
    [...(Number(process.versions.node.split('.')[0]) < 24 ? ['--experimental-strip-types'] : []), script, ...args],
    { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000 });
  const workflow = (steps: unknown[]) => {
    const file = join(dir, 'workflow.json');
    writeFileSync(file, JSON.stringify({ name: 'Test', steps }));
    return file;
  };
  const sql = () => new DatabaseSync(join(state, 'harness.sqlite3'));
  const clean = () => rmSync(dir, { recursive: true, force: true });
  return { run, workflow, sql, clean, state };
}
function submitted(result: { stdout: string }) {
  const id = result.stdout.match(/Submitted:\s*([0-9a-f]{12})/)?.[1];
  assert.ok(id, result.stdout);
  return id;
}

test('workflow validates cycles and unsafe writes', () => {
  const ctx = setup();
  try {
    const loop = ctx.workflow([{ id: 'a', prompt: 'A', depends_on: ['b'] }, { id: 'b', prompt: 'B', depends_on: ['a'] }]);
    let r = ctx.run(['submit', loop, '--goal', 'Goal']);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /cycle/i);
    const write = ctx.workflow([{ id: 'send', prompt: 'Send', mode: 'workspace-write' }]);
    r = ctx.run(['submit', write, '--goal', 'Goal']);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /approval/i);
  } finally { ctx.clean(); }
});

test('sequential pipeline persists outputs and raw event logs', () => {
  const ctx = setup();
  try {
    const wf = ctx.workflow([{ id: 'research', prompt: 'Research' }, { id: 'draft', prompt: 'Draft', depends_on: ['research'] }]);
    const r = ctx.run(['run', wf, '--goal', 'Market overview']);
    assert.equal(r.status, 0, r.stderr);
    const id = submitted(r);
    const db = ctx.sql();
    try {
      const steps = db.prepare('SELECT state,attempts FROM steps ORDER BY rowid').all() as { state: string; attempts: number }[];
      assert.deepEqual(steps.map(s => s.state), ['done', 'done']);
      assert.deepEqual(steps.map(s => s.attempts), [1, 1]);
    } finally { db.close(); }
    const log = join(ctx.state, 'jobs', id, 'logs', 'draft', 'attempt-1');
    assert.match(readFileSync(join(log, 'prompt.txt'), 'utf8'), /Mock answer: research/);
    assert.ok(existsSync(join(log, 'events.jsonl')));
  } finally { ctx.clean(); }
});

test('approval pauses and resumes without repeating completed steps', () => {
  const ctx = setup();
  try {
    const wf = ctx.workflow([{ id: 'plan', prompt: 'Plan' },
      { id: 'write', prompt: 'Write', mode: 'workspace-write', approval: true, depends_on: ['plan'] }]);
    let r = ctx.run(['run', wf, '--goal', 'Launch']);
    assert.equal(r.status, 0, r.stderr);
    const id = submitted(r);
    assert.match(r.stdout, /waiting_approval/);
    r = ctx.run(['approve', id, 'write']); assert.equal(r.status, 0, r.stderr);
    r = ctx.run(['worker']); assert.equal(r.status, 0, r.stderr);
    const db = ctx.sql();
    try {
      assert.deepEqual((db.prepare('SELECT state,attempts FROM steps ORDER BY rowid').all() as {state:string;attempts:number}[])
        .map(s => [s.state, s.attempts]), [['done',1], ['done',1]]);
    } finally { db.close(); }
  } finally { ctx.clean(); }
});

test('crash marks uncertain; retry requires fresh approval', () => {
  const ctx = setup();
  try {
    const wf = ctx.workflow([{ id: 'write', prompt: 'Write', mode: 'workspace-write', approval: true }]);
    const id = submitted(ctx.run(['submit', wf, '--goal', 'Goal']));
    const db = ctx.sql();
    db.prepare("UPDATE steps SET state='running' WHERE job_id=?").run(id);
    db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(id);
    db.close();
    let r = ctx.run(['worker']); assert.equal(r.status, 0, r.stderr);
    r = ctx.run(['status', id]); assert.match(r.stdout, /uncertain/);
    r = ctx.run(['retry', id, 'write']); assert.equal(r.status, 0, r.stderr);
    r = ctx.run(['worker']); assert.match(r.stdout, /waiting_approval/);
  } finally { ctx.clean(); }
});

test('provider failure event blocks after bounded retries', () => {
  const ctx = setup();
  try {
    const wf = ctx.workflow([{ id: 'research', prompt: 'Research' }]);
    const r = ctx.run(['run', wf, '--goal', 'Goal'], { FAIL_FAKE: '1' });
    const id = submitted(r);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /blocked/);
    const db = ctx.sql();
    try { assert.deepEqual({ ...db.prepare('SELECT state,attempts FROM steps').get() }, {state:'failed',attempts:2}); }
    finally {db.close();}
  } finally { ctx.clean(); }
});

test('dream proposals are not saved as memory until promoted', () => {
  const ctx = setup();
  try {
    const wf = ctx.workflow([{ id: 'research', prompt: 'Research' }]);
    const id = submitted(ctx.run(['run', wf, '--goal', 'Goal']));
    let r = ctx.run(['dream', id]); assert.equal(r.status, 0, r.stderr);
    const db = ctx.sql();
    try {
      assert.equal((db.prepare('SELECT count(*) AS n FROM memories').get() as {n:number}).n, 0);
      assert.equal((db.prepare('SELECT count(*) AS n FROM proposals').get() as {n:number}).n, 1);
    } finally { db.close(); }
    r = ctx.run(['memory', 'promote', '1']); assert.equal(r.status, 0, r.stderr);
    const db2 = ctx.sql();
    try { assert.equal((db2.prepare('SELECT count(*) AS n FROM memories').get() as {n:number}).n, 1); }
    finally { db2.close(); }
  } finally { ctx.clean(); }
});
