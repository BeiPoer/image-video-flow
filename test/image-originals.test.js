import test from 'node:test';
import assert from 'node:assert/strict';
import {imageOriginal} from '../image-originals.js';

const record=()=>({id:'asset-remote',kind:'image',createdAt:new Date().toISOString(),dataUrl:'https://example.test/image.png'});

test('external source is transient and leaves the full-size preview URL unchanged', async () => {
  const item=record(), source='data:image/png;base64,YWJj';
  let calls=0;
  const download=async url=>{assert.equal(url,item.dataUrl);calls++;return source;};
  assert.equal(await imageOriginal(item,download),source);
  assert.equal(await imageOriginal(item,download),source);
  assert.equal(calls,2,'only generated thumbnails are cached; originals are not retained by this resolver');
  assert.equal(item.dataUrl,'https://example.test/image.png');
  await assert.rejects(imageOriginal({...item,deletedAt:new Date().toISOString()},download),{status:410});
});

test('inline sources need no download; expiry during external download is checked', async () => {
  const item=record(),source='data:image/png;base64,YWJj';
  assert.equal(await imageOriginal({...item,dataUrl:source},()=>{throw Error('unexpected download');}),source);
  await assert.rejects(imageOriginal(item,async()=>{item.deletedAt=new Date().toISOString();return source;}),{status:410});
});
