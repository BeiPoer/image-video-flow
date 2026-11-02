import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkflowServer } from './fixtures/workflow-server.js';

const app = await startWorkflowServer(), fetch = app.fetch;
test('serves the workbench and bootstrap state', async () => {
  const html = await (await fetch(app.base + '/')).text();
  assert.match(html, /AI Media Flow/);
  const bootstrap = await (await fetch(app.base + '/api/bootstrap')).json();
  assert.ok(Array.isArray(bootstrap.projects));
  assert.ok(Array.isArray(bootstrap.shots));
});

test('creates a project and a shot', async () => {
  const project = await (await fetch(app.base + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '测试项目' }) })).json();
  assert.equal(project.name, '测试项目');
  const shot = await (await fetch(app.base + '/api/shots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: project.id, name: '测试镜头', imagePrompt: '一张测试图' }) })).json();
  assert.equal(shot.projectId, project.id);
});

test.after(app.stop);

