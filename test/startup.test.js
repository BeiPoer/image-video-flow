import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);
test('Windows launcher handles spaces, changes directory and loads optional .env', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-flow launch '));
  try {
    await copyFile(new URL('../start.bat', import.meta.url), join(dir, 'start.bat'));
    // Stub only the server: exercise the actual BAT without opening a browser or leaving a service running.
    await writeFile(join(dir, 'server.js'), `console.log('LAUNCH_CHECK=' + JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),value:process.env.FLOW_LAUNCH_CHECK||null}));`);
    const env = { ...process.env };
    delete env.FLOW_LAUNCH_CHECK;
    for (const configured of [false, true]) {
      if (configured) await writeFile(join(dir, '.env'), 'FLOW_LAUNCH_CHECK=loaded\n');
      const { stdout } = await exec('cmd.exe', ['/d', '/s', '/c', `""${join(dir, 'start.bat')}""`], { cwd: tmpdir(), env, timeout: 10000, windowsVerbatimArguments: true });
      const line = stdout.split(/\r?\n/).find(value => value.startsWith('LAUNCH_CHECK='));
      assert.ok(line, stdout);
      const result = JSON.parse(line.slice('LAUNCH_CHECK='.length));
      assert.equal(resolve(result.cwd), resolve(dir));
      assert.deepEqual(result.args, ['--open']);
      assert.equal(result.value, configured ? 'loaded' : null);
    }
  } finally {
    // dir is the unique test directory allocated above, never the project data directory.
    assert.equal(resolve(dir).startsWith(resolve(tmpdir()) + '\\ai-flow launch '), true);
    await rm(dir, { recursive: true, force: true });
  }
});
