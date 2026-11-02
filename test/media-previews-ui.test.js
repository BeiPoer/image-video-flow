import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {setStableMarkup} from '../public/stable-render.js';

test('cards load only lazy thumbnails; clicking opens originals and polling preserves the player', async () => {
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const items={
    'asset-image':{id:'asset-image',kind:'image',name:'图片',dataUrl:'/api/media/asset-image',thumbnailUrl:'/api/thumbnails/asset-image'},
    'result-video':{id:'result-video',kind:'video',name:'视频',dataUrl:'https://example.test/video.mp4',thumbnailUrl:'/api/thumbnails/result-video'},
  };
  const elements=new Map();let player;
  const context=vm.createContext({
    media:id=>items[id],esc:value=>String(value),sourceUrl:value=>value||'',showToast(){},
    $:id=>{if(!elements.has(id))elements.set(id,{showModal(){this.open=true;}});return elements.get(id);},
    document:{createElement(tag){assert.equal(tag,'video');player={setAttribute(){},addEventListener(){},play(){this.played=true;return Promise.resolve();}};return player;}},
  });
  vm.runInContext('let previewImageId;'+source.slice(source.indexOf('function displaySource('),source.indexOf('function reuseGenerationButton('))+source.slice(source.indexOf('function openImagePreview('),source.indexOf("$('#closeImagePreview')")),context);
  const image=vm.runInContext("preview(media('asset-image'))",context);
  assert.match(image,/src="\/api\/thumbnails\/asset-image"/);assert.match(image,/loading="lazy"/);
  assert.doesNotMatch(image,/src="\/api\/media\//);
  vm.runInContext("openImagePreview('asset-image')",context);
  assert.equal(elements.get('#imagePreviewFull').src,items['asset-image'].dataUrl);
  assert.equal(elements.get('#imagePreviewDialog').open,true);
  items['asset-image'].dataUrl='https://example.test/photo.png?signature=keep';
  vm.runInContext("openImagePreview('asset-image')",context);
  assert.equal(elements.get('#imagePreviewFull').src,items['asset-image'].dataUrl,'external previews must retain the exact URL and normal browser HTTP caching');
  const html=vm.runInContext("preview(media('result-video'))",context);
  assert.match(html,/data-play-video="result-video"/);assert.match(html,/src="\/api\/thumbnails\/result-video"/);
  assert.doesNotMatch(html,/<video|example\.test|preload="metadata"/);
  const card={innerHTML:''};setStableMarkup(card,html);
  context.button={dataset:{playVideo:'result-video'},replaceWith(value){card.player=value;}};
  vm.runInContext('playVideo(button)',context);
  assert.equal(player.src,items['result-video'].dataUrl);assert.equal(player.played,true);
  assert.equal(setStableMarkup(card,html),false);assert.equal(card.player,player);
  items['result-video'].deletedAt=new Date().toISOString();
  assert.doesNotMatch(vm.runInContext("preview(media('result-video'))",context),/<video|<img|data-play-video/);
});
