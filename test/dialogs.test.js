import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('workspace uses the requested fixed three-zone order, not free canvas controls', () => {
  const prep=html.indexOf('素材预处理区'),confirmed=html.indexOf('素材确认区'),video=html.indexOf('视频生成区');
  assert.ok(prep>=0 && prep<confirmed && confirmed<video);
  for (const id of ['uploadedMaterials','generatedMaterials','imageComposeForm','confirmedGrid','videoPicker','videoPrompt','generateVideoButton']) assert.match(html,new RegExp(`id="${id}"`));
  assert.ok(html.indexOf('id="uploadedMaterials"') < html.indexOf('id="generatedMaterials"'));
  assert.ok(html.indexOf('id="generatedMaterials"') < html.indexOf('id="imageComposeForm"'));
  assert.doesNotMatch(html,/id="prepCanvas"|id="addImageNodeButton"/);
  assert.doesNotMatch(html.slice(html.indexOf('素材确认区')), /id="prepCanvas"/);
  for (const selector of ['\.workflow-page','\.material-strip','\.confirmed-grid','\.video-picker']) assert.match(css,new RegExp(selector));
});

test('frontend wires image ingest, explicit confirmation, image editing and confirmed-only video selection', () => {
  for (const source of ["window.addEventListener('paste'", "window.addEventListener('drop'", 'function addConfirmed', 'function removeConfirmed', 'function generateImage', 'function generateVideo', 'confirmedIds', 'selectedImageIds', 'referenceImageIds', 'firstImageId', 'saveProjectMaterials']) assert.ok(script.includes(source),source);
  assert.match(script,/const records = confirmedIds\.map\(media\)/);
  assert.match(script,/请先从素材确认区选择视频素材/);
  assert.match(script,/confirmed-materials-v1/);
});

test('cancel controls stay non-submit and both generation prompts retain input limits', () => {
  const dialogs=[...html.matchAll(/<dialog\b[^>]*>([\s\S]*?)<\/dialog>/g)];assert.equal(dialogs.length,3);
  for(const [,body] of dialogs)for(const [,attrs] of body.matchAll(/<button\b([^>]*data-close[^>]*)>/g))assert.match(attrs,/type="button"/);
  assert.match(html,/id="imagePrompt"[^>]*maxlength="32000"[^>]*required/);
  assert.match(html,/id="videoPrompt"[^>]*maxlength="32000"/);
  assert.match(html,/id="videoSize"/);
});
