import { describe, expect, test } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-expect-error Release automation is plain Node.js and independently validated here.
import { releasePlan, prepareRelease } from './release.mjs';

const manifest = { name:'maccabi-health', version:'0.1.0', repository:{url:'git+https://github.com/example/project.git'} };
const event = (tag = 'v1.2.3', prerelease = false) => ({action:'published',release:{tag_name:tag,prerelease,draft:false},repository:{full_name:'example/project'}});
describe('release-only npm publication preparation', () => {
  test('stable and prerelease versions choose explicit npm tags', () => {
    expect(releasePlan(event(),manifest,{versions:{}})).toEqual({version:'1.2.3',distTag:'latest'});
    expect(releasePlan(event('v1.3.0-rc.2',true),manifest,{versions:{},'dist-tags':{latest:'1.2.3'}})).toEqual({version:'1.3.0-rc.2',distTag:'next'});
  });
  test('rejects invalid tags, prerelease disagreement, wrong events and repository mismatch', () => {
    for (const tag of ['1.2.3','v01.2.3','v1.2.3+build','v1.2.3-01','v999999999999999999.2.3','v1.2.3\nINJECT=1']) expect(() => releasePlan(event(tag),manifest,undefined)).toThrow();
    expect(() => releasePlan(event('v1.2.3-rc.1'),manifest,undefined)).toThrow();
    expect(() => releasePlan(event('v1.2.3',true),manifest,undefined)).toThrow();
    expect(() => releasePlan({...event(),action:'created'},manifest,undefined)).toThrow();
    expect(() => releasePlan({...event(),repository:{full_name:'other/project'}},manifest,undefined)).toThrow();
  });
  test('rejects existing versions, stable latest regression and malformed registry data', () => {
    expect(() => releasePlan(event(),manifest,{versions:{'1.2.3':{}}})).toThrow(/already exists/);
    expect(() => releasePlan(event(),manifest,{versions:{},'dist-tags':{latest:'2.0.0'}})).toThrow(/advance/);
    expect(() => releasePlan(event(),manifest,{versions:[]})).toThrow();
    expect(() => releasePlan(event(),manifest,null)).toThrow(/trusted publisher/);
  });
  test('only anonymous registry lookup precedes runner-only manifest and root-lock stamping', async () => {
    const directory = await mkdtemp(join(tmpdir(),'maccabi-release-test-'));
    const root = pathToFileURL(directory + '/');
    try {
      const lock = {name:manifest.name,version:manifest.version,packages:{'':{...manifest},'packages/core':{version:'0.1.0'}}};
      const server = {name:'io.github.example/project',version:'0.1.0',packages:[{registryType:'npm',identifier:manifest.name,version:'0.1.0'}]};
      await writeFile(new URL('package.json',root),JSON.stringify(manifest));
      await writeFile(new URL('package-lock.json',root),JSON.stringify(lock));
      await writeFile(new URL('server.json',root),JSON.stringify(server));
      let calls = 0;
      const result = await prepareRelease(event(),root,async (url: string, init: RequestInit) => {
        calls++; expect(url).toBe('https://registry.npmjs.org/maccabi-health'); expect(init.credentials).toBe('omit'); expect(init.redirect).toBe('error'); expect(init.headers).toBeUndefined();
        return Response.json({versions:{}});
      });
      expect(calls).toBe(1); expect(result.version).toBe('1.2.3');
      expect(JSON.parse(await readFile(new URL('package.json',root),'utf8')).version).toBe('1.2.3');
      const updated = JSON.parse(await readFile(new URL('package-lock.json',root),'utf8'));
      expect(updated.packages[''].version).toBe('1.2.3'); expect(updated.packages['packages/core'].version).toBe('0.1.0');
      // The MCP registry rejects a server.json whose two version fields disagree with the npm package.
      const stamped = JSON.parse(await readFile(new URL('server.json',root),'utf8'));
      expect(stamped.version).toBe('1.2.3'); expect(stamped.packages[0].version).toBe('1.2.3');
      await expect(prepareRelease(event('v1.2.4'),root,async () => new Response('',{status:404}))).rejects.toThrow(/trusted publisher/);
      expect(JSON.parse(await readFile(new URL('package.json',root),'utf8')).version).toBe('1.2.3');
      await expect(prepareRelease(event('invalid'),root,async () => {throw new Error('must not fetch');})).rejects.toThrow(/Use v/);
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
});
