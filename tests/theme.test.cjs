'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const code=fs.readFileSync(path.join(__dirname,'../assets/theme.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'../assets/app.css'),'utf8');
const KEY='em-dia-theme-v1';

function device({values=new Map(),getError=false,setError=false}={}){
  const reads=[],writes=[],events={},meta={content:null,setAttribute(name,value){this[name]=value;}};
  const html={dataset:{},style:{}};
  const storage={getItem(key){reads.push(key);if(getError)throw new Error('Device storage blocked');return values.get(key)??null;},setItem(key,value){writes.push([key,value]);if(setError)throw new Error('Quota');values.set(key,value);}};
  const window={document:{documentElement:html,querySelector(selector){return selector==='meta[name="theme-color"]'?meta:null;}},localStorage:storage,addEventListener(name,handler){events[name]=handler;}};
  vm.runInNewContext(code,{window});
  return {api:window.EmDiaTheme,html,meta,reads,writes,events,values};
}

test('a first visit keeps the original light appearance and reads only the theme preference',()=>{
  const d=device({values:new Map([['em-dia-auth-v1','PRIVATE_SESSION'],['other-app','PRIVATE_DATA']])});
  assert.equal(d.api.current(),'light');assert.equal(d.html.dataset.theme,'light');assert.equal(d.html.style.colorScheme,'light');assert.equal(d.meta.content,'#ffffff');
  assert.deepEqual(d.reads,[KEY]);assert.deepEqual(d.writes,[]);assert.equal(d.values.get('em-dia-auth-v1'),'PRIVATE_SESSION');assert.ok(Object.isFrozen(d.api));
});

test('saved dark appearance is applied synchronously before the rest of the page loads',()=>{
  const d=device({values:new Map([[KEY,'dark']])});
  assert.equal(d.html.dataset.theme,'dark');assert.equal(d.html.style.colorScheme,'dark');assert.equal(d.meta.content,'#0d1b1e');assert.equal(d.api.current(),'dark');
  d.api.init();d.api.init();assert.deepEqual(d.reads,[KEY]);assert.equal(Object.keys(d.events).length,1);assert.deepEqual(d.writes,[]);
});

test('manual toggles persist across reopening without storing account information',()=>{
  const values=new Map(),a=device({values});
  assert.equal(a.api.toggle(),'dark');assert.equal(a.html.dataset.theme,'dark');assert.deepEqual(a.writes,[[KEY,'dark']]);
  const reopened=device({values});assert.equal(reopened.api.current(),'dark');assert.equal(reopened.api.toggle(),'light');
  assert.equal(device({values}).api.current(),'light');assert.deepEqual([...values],[[KEY,'light']]);
});

test('blocked or full device storage still allows theme changes in the current page',()=>{
  const d=device({getError:true,setError:true});
  assert.equal(d.api.current(),'light');assert.doesNotThrow(()=>d.api.toggle());assert.equal(d.api.current(),'dark');assert.equal(d.html.dataset.theme,'dark');
  assert.doesNotThrow(()=>d.api.apply('light'));assert.equal(d.html.style.colorScheme,'light');
});

test('invalid saved values do not become CSS values or overwrite the stored setting on load',()=>{
  for(const value of ['system','DARK','<script>','url(private)','',null]){
    const d=device({values:new Map([[KEY,value]])});assert.equal(d.api.current(),'light');assert.equal(d.html.dataset.theme,'light');assert.deepEqual(d.writes,[]);
  }
});

test('another tab updates the appearance without echo writes or reacting to account storage',()=>{
  const d=device(),changes=[];d.api.subscribe(value=>changes.push(value));
  d.events.storage({key:'em-dia-auth-v1',newValue:'PRIVATE_SESSION'});assert.equal(d.api.current(),'light');
  d.events.storage({key:KEY,newValue:'dark'});assert.equal(d.api.current(),'dark');assert.equal(d.meta.content,'#0d1b1e');
  d.events.storage({key:KEY,newValue:null});assert.equal(d.api.current(),'light');assert.deepEqual(d.writes,[]);assert.deepEqual(changes,['light','dark','light']);
});

test('invalid explicit theme changes leave the current page and stored preference intact',()=>{
  const d=device({values:new Map([[KEY,'dark']])});
  assert.throws(()=>d.api.apply('private-account-id'),/tema claro ou escuro/);assert.equal(d.api.current(),'dark');assert.equal(d.html.dataset.theme,'dark');assert.equal(d.values.get(KEY),'dark');assert.deepEqual(d.writes,[]);
});

test('a faulty or removed view cannot interrupt theme changes or accumulate duplicate listeners',()=>{
  const d=device(),changes=[];
  const stop=d.api.subscribe(value=>changes.push(value));d.api.subscribe(()=>{throw new Error('View failed');});
  assert.doesNotThrow(()=>d.api.toggle());stop();d.api.toggle();assert.deepEqual(changes,['light','dark']);
});

function luminance(hex){const channels=hex.replace('#','').match(/../g).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return .2126*channels[0]+.7152*channels[1]+.0722*channels[2];}
function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
function rules(source,ancestors=[]){
  const result=[];let pos=0;
  while(pos<source.length){const start=source.indexOf('{',pos);if(start<0)break;let depth=1,end=start+1;for(;end<source.length&&depth;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}
    assert.equal(depth,0,'The stylesheet must have balanced blocks');const selector=source.slice(pos,start).trim(),body=source.slice(start+1,end-1);if(selector.startsWith('@media'))result.push(...rules(body,[...ancestors,selector]));else result.push({selector,body,ancestors});pos=end;
  }return result;
}
const parsed=rules(css.replace(/\/\*[\s\S]*?\*\//g,''));

test('dark text, muted labels, fields and semantic notices retain readable contrast',()=>{
  const root=parsed.find(rule=>rule.selector==='html[data-theme="dark"]'&&rule.ancestors.some(value=>value.includes('screen')));
  assert.ok(root);const palette=Object.fromEntries([...root.body.matchAll(/--([a-z-]+):(#[0-9a-f]{6})/g)].map(match=>[match[1],match[2]]));
  for(const [foreground,background,min] of [['ink','bg',7],['ink','paper',7],['ink','field-bg',7],['muted','paper',4.5],['green','soft',4.5],['on-green','green',7],['amber','amber-bg',4.5],['purple','purple-bg',4.5],['red','red-bg',4.5],['focus','paper',3],['field-line','field-bg',3]]){
    assert.ok(contrast(palette[foreground],palette[background])>=min,foreground+' on '+background+' needs contrast '+min);
  }
});

test('dark surface overrides stay screen-only and cannot invert printed reports',()=>{
  const themed=parsed.filter(rule=>rule.selector.includes('html[data-theme="dark"]'));
  assert.ok(themed.length>20);
  for(const rule of themed){if(rule.ancestors.some(value=>value.includes('print'))){assert.equal(rule.body.trim(),'color-scheme:light!important');}
    else assert.ok(rule.ancestors.some(value=>value==='@media screen'),'Dark surface leaked into print: '+rule.selector);
  }
});
