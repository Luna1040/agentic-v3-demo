import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadRuntime} from '../server/load-runtime.ts';

test('a rebuilt manifest cannot relabel the process-cached Harness code',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'agentic-harness-identity-'));
  const oldPath=process.env.HARNESS_MODULE_PATH, oldMode=process.env.MODEL_MODE;
  try {
    process.env.HARNESS_MODULE_PATH=join(directory,'runtime.mjs');process.env.MODEL_MODE='demo';
    const source=(model:string)=>`export function createStoryRuntime(){return {metadata:{version:1},status:{model:${JSON.stringify(model)},harnessVersion:'fixture'},actor(){},updateWorld(){},runTurn(){}}}`;
    await writeFile(process.env.HARNESS_MODULE_PATH,source('first'));
    const manifest={sourceCommit:'1'.repeat(40),appSourceHash:'2'.repeat(64)};
    await writeFile(join(directory,'build.json'),JSON.stringify(manifest));
    const first=await loadRuntime();assert.equal(first.status.model,'first');
    const sameBuild=await loadRuntime({promptVersions:{actor:12}});
    assert.equal(sameBuild.metadata?.appSourceHash,manifest.appSourceHash);
    await writeFile(process.env.HARNESS_MODULE_PATH,source('second'));
    await writeFile(join(directory,'build.json'),JSON.stringify({...manifest,appSourceHash:'3'.repeat(64)}));
    await assert.rejects(loadRuntime(),{code:'HARNESS_RESTART_REQUIRED'});
  } finally {
    if(oldPath===undefined)delete process.env.HARNESS_MODULE_PATH;else process.env.HARNESS_MODULE_PATH=oldPath;
    if(oldMode===undefined)delete process.env.MODEL_MODE;else process.env.MODEL_MODE=oldMode;
    // This exact directory was created above by mkdtemp and contains only this fixture.
    await rm(directory,{recursive:true,force:true});
  }
});
