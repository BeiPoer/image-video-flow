import {loginFetch,testPassword} from './fixtures/auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const port = 4189;
const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, APP_ACCESS_PASSWORD:testPassword, APP_COOKIE_SECURE:'false', AI_FLOW_PORT: String(port), AI_FLOW_DATA_DIR: './data-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server start timeout')), 3000); child.stdout.on('data', (chunk) => { if (String(chunk).includes('running')) { clearTimeout(timer); resolve(); } }); child.on('error', reject); });

const fetch=await loginFetch(`http://localhost:${port}`);
test('serves the workbench and bootstrap state', async () => {
  const html = await (await fetch(`http://localhost:${port}/`)).text();
  assert.match(html, /AI Media Flow/);
  const bootstrap = await (await fetch(`http://localhost:${port}/api/bootstrap`)).json();
  assert.ok(Array.isArray(bootstrap.projects));
  assert.ok(Array.isArray(bootstrap.shots));
});

test('creates a project and a shot', async () => {
  const project = await (await fetch(`http://localhost:${port}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '测试项目' }) })).json();
  assert.equal(project.name, '测试项目');
  const shot = await (await fetch(`http://localhost:${port}/api/shots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: project.id, name: '测试镜头', imagePrompt: '一张测试图' }) })).json();
  assert.equal(shot.projectId, project.id);
});

test.after(() => child.kill());

