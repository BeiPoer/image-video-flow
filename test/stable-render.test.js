import test from 'node:test';
import assert from 'node:assert/strict';
import {setStableMarkup,renderVideoCards} from '../public/stable-render.js';
import {createRenderElement} from './fixtures/render-dom.js';

test('unchanged polling does not rebuild DOM or reset any video player; sibling changes stay isolated',()=>{
  const container=createRenderElement();
  const ready={id:'ready',html:'<video controls src="result.mp4"></video>'},pending={id:'pending',html:'<div>视频生成中</div>'};
  renderVideoCards(container,[pending,ready]);
  const [pendingElement,readyElement]=container.children,player=readyElement.player;
  player.currentTime=18;
  const moves=container.moves;
  for(let i=0;i<5;i++)renderVideoCards(container,[pending,ready]);
  assert.equal(container.moves,moves);assert.equal(readyElement.writes,1);assert.equal(pendingElement.writes,1);
  assert.equal(readyElement.player,player);assert.equal(player.currentTime,18);
  renderVideoCards(container,[{id:'new',html:'<div>排队中</div>'},pending,ready]);
  assert.equal(container.children[2],readyElement);assert.equal(readyElement.player,player);
  renderVideoCards(container,[{id:'new',html:'<div>排队中</div>'},{id:'pending',html:'<video src="second.mp4"></video>'},ready]);
  assert.equal(container.children[1],pendingElement);assert.equal(pendingElement.writes,2);
  assert.equal(readyElement.writes,1);assert.equal(readyElement.player.currentTime,18);
  renderVideoCards(container,[ready]);assert.equal(container.children.length,1);assert.equal(container.children[0],readyElement);
});
test('markup comparison is not confused by browser-normalized HTML',()=>{
  const element=createRenderElement(),html='<img src="x" />';
  assert.equal(setStableMarkup(element,html),true);
  assert.equal(setStableMarkup(element,html),false);assert.equal(element.writes,1);
  assert.equal(setStableMarkup(element,'<img src="y" />'),true);assert.equal(element.writes,2);
});
