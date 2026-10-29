// Ver.0.8 internal browser check: import the dormant recorder, observe a real UI discard,
// and replay privately. Does not install production hooks or alter DOM/CSS/storage formats.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { startServer } from '../../tools/serve.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const server=await startServer(0,{base:'/mathjong/',host:'127.0.0.1'});
let browser;
try{
  const channel=process.argv.includes('--channel')?process.argv[process.argv.indexOf('--channel')+1]:undefined;
  browser=await chromium.launch({args:['--no-proxy-server'],...(channel?{channel}:{})});
  for(const mode of ['math1','math2'])for(const width of [320,390]){
    const ctx=await browser.newContext({viewport:{width,height:844},isMobile:true,hasTouch:true});
    const page=await ctx.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    page.on('response',r=>{if(r.status()>=400)errors.push(`HTTP ${r.status()} ${r.url()}`);});
    page.on('requestfailed',r=>errors.push(`failed ${r.url()}`));
    await page.goto(`http://localhost:${server.address().port}/mathjong/?seed=81&mode=${mode}&speed=slow&len=8`);
    await page.locator('.self .hand .tile.drawn').waitFor();
    const initial=await page.evaluate(async()=>{
      const m=window.__mathjong,api=await import(new URL('src/engine/paifu.js',location.href));
      const previous=JSON.stringify(api.captureGame(m.S.game));
      const savedKeys=Object.keys(localStorage).sort(),saved=savedKeys.map(k=>[k,localStorage.getItem(k)]);
      const before=api.captureGame(m.S.game);
      const record=api.beginRound(api.createPaifu({id:'browser-test',rules:m.rules,players:m.S.game.players,
        match:m.S.match,seedBase:m.S.seedBase,firstRound:m.S.round,appVersion:'0.7.0-a'}),m.S.game);
      if(previous!==JSON.stringify(api.captureGame(m.S.game)))throw Error('recorder mutated live game');
      window.__paifuTest={api,record,before,saved,after:null};
      // Observe after app's synchronous click handler, before an AI timeout can run.
      // This keeps one real UI action deterministic even on a heavily loaded CI machine.
      const observe=()=>{
        if(m.S.game.events.length===before.events.length)return;
        clearTimeout(m.S.timer);m.S.timer=null;
        window.__paifuTest.after=api.captureGame(m.S.game);
        window.removeEventListener('click',observe);
      };
      window.addEventListener('click',observe);
      return {tile:before.drawn,events:before.events.length};
    });
    const tile=page.locator(`.self .hand .tile[data-id="${initial.tile}"]`);
    await tile.tap();
    assert.equal(await page.evaluate(()=>window.__mathjong.S.game.events.length),initial.events);
    await page.locator(`.self .hand .tile[data-id="${initial.tile}"]`).tap();
    const result=await page.evaluate(()=>{
      const m=window.__mathjong,{api,before,after,record,saved}=window.__paifuTest;
      if(!after)throw Error('UI discard was not observed synchronously');
      const unchanged=JSON.stringify(api.captureGame(m.S.game)),start=performance.now();
      const p=api.appendDecision(record,{before,after,seat:0,action:{type:'discard',tile:before.drawn},atMs:10});
      const appendMs=performance.now()-start,json=api.encodePaifu(p),decoded=api.decodePaifu(json);
      const replay=api.captureGame(api.replayPrivateRound(decoded,0));
      const report=api.verifyPaifu(decoded);
      return {liveUnchanged:JSON.stringify(api.captureGame(m.S.game))===unchanged,
        replay,after,schema:decoded.schemaVersion,visibility:decoded.visibility,
        report,bytes:new TextEncoder().encode(json).length,appendMs,
        keysUnchanged:JSON.stringify(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)]))===JSON.stringify(saved),
        discards:after.events.filter(e=>e.type==='discard'&&e.seat===0&&e.tile===before.drawn).length,
        beforeDiscard:decoded.rounds[0].steps[0].events.find(e=>e.type==='discard').tile};
    });
    assert.ok(result.liveUnchanged&&result.keysUnchanged,JSON.stringify({liveUnchanged:result.liveUnchanged,keysUnchanged:result.keysUnchanged}));
    assert.deepEqual(result.replay,result.after,'all state values and ordered arrays must match; JSON object key order is immaterial');
    delete result.replay;delete result.after;
    assert.equal(result.discards,1);assert.equal(result.beforeDiscard,initial.tile);
    assert.equal(result.schema,1);assert.equal(result.report.decisions,1);assert.equal(result.visibility,'private-full');
    assert.deepEqual(errors,[]);
    console.log('PAIFU_BROWSER '+JSON.stringify({mode,width,browser:browser.version(),...result}));
    await ctx.close();
  }
  console.log('PAIFU E2E OK: math1/math2 x 320/390, real double tap, round-trip state, no live/storage mutation');
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
