'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {IDBFactory,IDBObjectStore}=require('fake-indexeddb');
const Account=require('../assets/account.js'),Cloud=require('../assets/cloud.js');
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const NOW=Date.parse('2026-11-06T15:00:00Z');
const JPEG='data:image/jpeg;base64,'+Buffer.from([255,216,255,224,0,1,255,217]).toString('base64');
const clone=x=>JSON.parse(JSON.stringify(x));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const transport=()=>({code:'network_error',message:'PRIVATE_REQUEST_FIXTURE'});
function harness(options={}){
  const factory=options.factory||new IDBFactory(),calls=[],authRequests=[],profiles=new Map();
  let identity=A,sdk=A,connected=true,denial=null,gate=null,readOverride=null,fetchOverride=null;
  const roles=new Map([[A,options.role||'publisher'],[B,'superintendent']]);
  const defaultProfile=id=>({user_id:id,display_name:'',avatar_data:null,version:0,updated_at:null});
  const profile=id=>profiles.get(id)||defaultProfile(id);
  const token=id=>'fixture-token-'+id;
  const client={auth:{
    async getSession(){calls.push({method:'getSession'});return {data:{session:{user:{id:sdk},access_token:token(sdk)}},error:null};},
    async getUser(jwt){calls.push({method:'getUser',explicit:jwt!==undefined});if(denial) return {data:{user:null},error:denial};if(!connected)throw transport();const id=jwt?.startsWith('fixture-token-')?jwt.slice('fixture-token-'.length):sdk;return {data:{user:{id,email:'private-fixture@example.invalid'}},error:null};},
    async updateUser(){throw Error('Shared SDK updateUser must never be used for a captured credential action.');},
    async reauthenticate(){throw Error('Shared SDK reauthenticate must never choose a changed account.');}
  },async rpc(method,args){calls.push({method,args:clone(args||{})});if(!connected)throw transport();
    if(method==='get_em_dia_access_profile'){if(denial)return{data:null,error:denial};return{data:{user_id:sdk,role:roles.get(sdk),is_admin:roles.get(sdk)==='admin'},error:null};}
    if(gate)await gate.promise;
    if(args?.p_expected_user_id!==sdk)return {data:null,error:{code:'42501'}};
    if(method==='read_em_dia_own_account_profile')return {data:readOverride||clone(profile(sdk)),error:null};
    if(method==='save_em_dia_own_account_profile'){
      const old=profile(sdk);if(args.p_expected_version!==old.version)return {data:null,error:{code:'40001'}};
      if(args.p_display_name===old.display_name&&args.p_avatar_data===old.avatar_data)return{data:clone(old),error:null};
      const next={user_id:sdk,display_name:args.p_display_name,avatar_data:args.p_avatar_data,version:old.version+1,updated_at:new Date(NOW).toISOString()};profiles.set(sdk,next);return {data:clone(next),error:null};
    }throw Error('Unexpected RPC fixture '+method);
  }};
  const fetcher=async(url,request)=>{authRequests.push({url,method:request.method,headers:{...request.headers},body:request.body});if(fetchOverride)return fetchOverride(url,request);return {ok:true,status:200,json:async()=>url.endsWith('/user')?{id:A}: {}};};
  return {factory,client,calls,authRequests,profiles,profile,
    create(extra={}){return Account.create({client,indexedDB:factory,identity:()=>identity,online:()=>connected,now:()=>NOW,authUrl:'https://fixture.supabase.co/auth/v1',publishableKey:'sb_publishable_fixture',fetch:fetcher,...extra});},
    offline(){connected=false;},online(){connected=true;},identity(id){identity=id;sdk=id;},setSdk(id){sdk=id;},deny(error={code:'42501',status:403}){denial=error;},allow(){denial=null;},gate(value){gate=value;},overrideRead(value){readOverride=value;},fetch(value){fetchOverride=value;},token
  };
}
async function stored(factory,userId=A,mutate){
  const db=await new Promise((resolve,reject)=>{const r=factory.open('em-dia-account-private-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('profiles',{keyPath:'userId'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction('profiles',mutate?'readwrite':'readonly'),store=tx.objectStore('profiles'),r=store.get(userId);let value;r.onsuccess=()=>{value=mutate?mutate(r.result):r.result;if(mutate){if(value===null)store.delete(userId);else store.put(value);}};tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(tx.error);});}finally{db.close();}
}
test('default own profile is confirmed online and reopens without internet for all three roles',async()=>{
  for(const role of ['admin','superintendent','publisher']){const h=harness({role}),api=h.create();const p=await api.load({expectedUserId:A});assert.equal(p.version,0);assert.equal(p.avatarData,null);assert.equal(p.displayName,'');assert.equal(p.cached,false);assert.equal(p.cacheAvailable,true);h.offline();const reopened=await h.create().load({expectedUserId:A});assert.equal(reopened.userId,A);assert.equal(reopened.cached,true);assert.equal(h.calls.filter(x=>x.method==='read_em_dia_own_account_profile').length,1);}
});
test('saving own display name and photo sends an explicit actor and persists only allowed profile fields',async()=>{
  const h=harness(),api=h.create();await api.load();const result=await api.save({displayName:'  Profile   fixture  ',avatarData:JPEG,expectedVersion:0,expectedUserId:A});assert.equal(result.confirmed,true);assert.equal(result.displayName,'Profile fixture');assert.equal(result.version,1);assert.equal(result.avatarData,JPEG);const call=h.calls.find(x=>x.method==='save_em_dia_own_account_profile');assert.deepEqual(call.args,{p_display_name:'Profile fixture',p_avatar_data:JPEG,p_expected_version:0,p_expected_user_id:A});const row=await stored(h.factory);assert.deepEqual(Object.keys(row).sort(),['blocked','generation','profile','userId']);assert.doesNotMatch(JSON.stringify(row),/private-fixture@|access_token|refresh_token|fixture-token|password|headers/);h.offline();assert.equal((await h.create().getCached()).avatarData,JPEG);
});
test('avatar removal and an unchanged default are deliberate CAS operations',async()=>{
  const h=harness(),api=h.create();await api.load();const noop=await api.save({displayName:'',avatarData:null,expectedVersion:0,expectedUserId:A});assert.equal(noop.version,0);const first=await api.save({displayName:'Fixture',avatarData:JPEG,expectedVersion:0,expectedUserId:A});const removed=await api.save({displayName:'Fixture',avatarData:null,expectedVersion:first.version,expectedUserId:A});assert.equal(removed.avatarData,null);assert.equal(removed.version,2);
});
test('profile writes are online only and passwords never enter a metadata RPC',async()=>{
  const h=harness(),api=h.create();await api.load();h.offline();await assert.rejects(api.save({displayName:'Fixture',avatarData:JPEG,expectedVersion:0,expectedUserId:A}),e=>e.code==='online_required');await assert.rejects(api.changePassword({currentPassword:'old-fixture-password',password:'new-fixture-password',expectedUserId:A}),e=>e.code==='online_required');assert.equal(h.calls.filter(x=>x.method.startsWith('save_')).length,0);assert.equal(h.authRequests.length,0);
});
test('account and expected identity isolation applies to cached reads and pending network results',async()=>{
  const h=harness(),api=h.create();await api.load();await api.save({displayName:'Only fixture A',avatarData:JPEG,expectedVersion:0,expectedUserId:A});h.identity(B);h.offline();assert.equal(await api.getCached(),null);await assert.rejects(api.getCached({expectedUserId:A}),e=>e.code==='auth_changed');h.online();assert.equal((await api.load({expectedUserId:B})).displayName,'');h.identity(A);const gate=deferred();h.gate(gate);const delayed=api.load({expectedUserId:A});while(!h.calls.some(x=>x.method==='read_em_dia_own_account_profile'&&x.args.p_expected_user_id===A))await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));h.identity(B);gate.resolve();await assert.rejects(delayed,e=>e.code==='auth_changed');assert.equal((await api.getCached()).displayName,'');
});
test('the server actor guard prevents an account switch immediately before RPC dispatch from changing another profile',async()=>{
  const h=harness(),api=h.create();await api.load();const rpc=h.client.rpc;h.client.rpc=async(method,args)=>{if(method==='save_em_dia_own_account_profile')h.identity(B);return rpc(method,args);};await assert.rejects(api.save({displayName:'A fixture',avatarData:JPEG,expectedVersion:0,expectedUserId:A}),e=>e.code==='auth_changed');assert.equal(h.profile(A).version,0);assert.equal(h.profile(B).version,0);assert.equal((await stored(h.factory,A)).blocked,null);
});
test('confirmed global revocation is durable and online revalidation restores only the original account',async()=>{
  const h=harness(),api=h.create();await api.load();h.deny();await assert.rejects(api.load(),e=>e instanceof Cloud.AccessDeniedError&&e.globalAccessLost);h.offline();await assert.rejects(h.create().load(),Cloud.AccessDeniedError);h.online();h.allow();const fresh=await h.create().load({expectedUserId:A});assert.equal(fresh.userId,A);h.offline();assert.equal((await h.create().getCached()).userId,A);
});
test('a verified expired session seals the profile while auth changes never seal the new account',async()=>{
  const h=harness(),api=h.create();await api.load();h.deny({status:401,code:'bad_jwt'});await assert.rejects(api.save({displayName:'Fixture',avatarData:null,expectedVersion:0,expectedUserId:A}),Cloud.AuthRequiredError);assert.equal((await stored(h.factory)).blocked,'auth_required');h.allow();h.identity(B);await api.load({expectedUserId:B});assert.equal((await stored(h.factory,B)).blocked,null);
});
test('clearMemory and explicit forget prevent a late response from restoring a logged-out copy',async()=>{
  const h=harness(),api=h.create();await api.load();const gate=deferred();h.gate(gate);const pending=api.load(),rejection=assert.rejects(pending,e=>e.code==='auth_changed');await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));api.clearMemory();h.identity(null);await api.forget(A);gate.resolve();await rejection;assert.equal((await stored(h.factory,A)).profile,null);h.identity(A);h.offline();assert.equal(await h.create().getCached(),null);
});
test('forget in another instance leaves a data-free tombstone that stops an old response from recreating the photo',async()=>{
  const h=harness(),one=h.create(),two=h.create();await one.load();const gate=deferred(),entered=deferred(),rpc=h.client.rpc;
  h.client.rpc=async(method,args)=>{if(method==='read_em_dia_own_account_profile'){const old=await rpc(method,args);entered.resolve();await gate.promise;return old;}return rpc(method,args);};
  const pending=one.load(),rejection=assert.rejects(pending,e=>e.code==='auth_changed');await entered.promise;await two.forget(A);gate.resolve();await rejection;const row=await stored(h.factory);assert.equal(row.profile,null);assert.equal(row.generation,1);assert.equal(await one.getCached(),null);
});
test('revocation in another instance cannot be undone by a profile response verified before that revocation',async()=>{
  const h=harness(),one=h.create(),two=h.create();await one.load();const gate=deferred(),entered=deferred(),rpc=h.client.rpc;
  h.client.rpc=async(method,args)=>{if(method==='read_em_dia_own_account_profile'){const old=await rpc(method,args);entered.resolve();await gate.promise;return old;}return rpc(method,args);};
  const pending=one.load(),rejection=assert.rejects(pending,e=>e.code==='auth_changed');await entered.promise;h.deny();await assert.rejects(two.load(),Cloud.AccessDeniedError);gate.resolve();await rejection;h.offline();await assert.rejects(one.getCached(),Cloud.AccessDeniedError);assert.equal((await stored(h.factory)).blocked,'access_denied');
});
test('late logout cleanup for account A cannot invalidate a profile load already authorized for account B',async()=>{
  const h=harness(),api=h.create();await api.load({expectedUserId:A});h.identity(B);await api.load({expectedUserId:B});
  const gate=deferred(),entered=deferred(),rpc=h.client.rpc;h.client.rpc=async(method,args)=>{if(method==='read_em_dia_own_account_profile'&&args.p_expected_user_id===B){const response=await rpc(method,args);entered.resolve();await gate.promise;return response;}return rpc(method,args);};
  const pending=api.load({expectedUserId:B});await entered.promise;await api.forget(A);gate.resolve();const result=await pending;
  assert.equal(result.userId,B);assert.equal((await api.getCached()).userId,B);assert.equal((await stored(h.factory,A)).profile,null);assert.equal((await stored(h.factory,B)).blocked,null);
});
test('a concurrent remote edit causes a conflict without rebasing or overwriting the profile',async()=>{
  const h=harness(),api=h.create();await api.load();h.profiles.set(A,{user_id:A,display_name:'Remote fixture',avatar_data:null,version:1,updated_at:new Date(NOW).toISOString()});await assert.rejects(api.save({displayName:'Local fixture',avatarData:JPEG,expectedVersion:0,expectedUserId:A}),Cloud.ConflictError);assert.equal(h.profile(A).display_name,'Remote fixture');assert.equal((await api.getCached()).version,0);assert.equal((await api.load()).displayName,'Remote fixture');
});
test('an older read response never replaces a newer confirmed account cache',async()=>{
  const h=harness(),one=h.create(),two=h.create();await one.load();const old=clone(h.profile(A)),gate=deferred(),rpc=h.client.rpc;let reads=0;h.client.rpc=async(method,args)=>{if(method==='read_em_dia_own_account_profile'&&++reads===1){await gate.promise;return{data:old,error:null};}return rpc(method,args);};const reading=one.load();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));const saved=await two.save({displayName:'Newest fixture',avatarData:JPEG,expectedVersion:0,expectedUserId:A});gate.resolve();assert.equal((await reading).version,saved.version);assert.equal((await one.getCached()).displayName,'Newest fixture');
});
test('metadata network timeouts return an existing private copy and do not install late data',async()=>{
  const h=harness(),api=h.create({networkTimeoutMs:5});await api.load();const gate=deferred(),old=clone(h.profile(A));old.display_name='Late fixture';h.overrideRead(old);h.gate(gate);const result=await api.load();assert.equal(result.cached,true);assert.equal(result.stale,true);gate.resolve();await new Promise(r=>setImmediate(r));assert.equal((await api.getCached()).displayName,'');
});
test('a read misses safely offline and an unavailable private store still permits a confirmed online profile',async()=>{
  const h=harness();h.offline();assert.equal(await h.create().load(),null);h.online();const api=h.create({indexedDB:null});const result=await api.load();assert.equal(result.userId,A);assert.equal(result.cacheAvailable,false);assert.equal((await api.getCached()).userId,A);
});
test('quota failure after a confirmed save returns a cache warning and retains the confirmed in-memory value',async()=>{
  const h=harness(),api=h.create();await api.load();const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(){throw new DOMException('Quota fixture','QuotaExceededError');};try{const result=await api.save({displayName:'Confirmed fixture',avatarData:JPEG,expectedVersion:0,expectedUserId:A});assert.equal(result.confirmed,true);assert.equal(result.cacheAvailable,false);assert.ok(result.cacheWarning);assert.equal(h.profile(A).version,1);assert.equal((await api.getCached()).displayName,'Confirmed fixture');assert.equal((await stored(h.factory)).profile.version,0);}finally{IDBObjectStore.prototype.put=put;}
});
test('malformed cross-account cache data never render and a verified online read can replace the unusable record',async()=>{
  const h=harness(),api=h.create();await api.load();await stored(h.factory,A,row=>({...row,profile:{...row.profile,userId:B,displayName:'Wrong fixture'}}));h.offline();await assert.rejects(api.getCached(),e=>e.code==='invalid_response');h.online();assert.equal((await api.load()).displayName,'');
});
test('malformed RPC profiles, off-account data, unsafe image URLs and unexpected versions are rejected',async()=>{
  for(const change of [{user_id:B},{avatar_data:'https://example.invalid/private.jpeg'},{avatar_data:'data:image/svg+xml,<svg/>'},{version:1,updated_at:null},{display_name:'bad\u0000name'},{display_name:'x'.repeat(81)}]){const h=harness();h.overrideRead({...h.profile(A),...change});await assert.rejects(h.create().load(),e=>e.code==='invalid_response');assert.equal(await stored(h.factory),undefined);}
});
test('display names use codepoint length and permit normalized Unicode without granting privileges',async()=>{
  const h=harness(),api=h.create();await api.load();const good='😀'.repeat(80);assert.equal((await api.save({displayName:good,avatarData:null,expectedVersion:0,expectedUserId:A})).displayName,good);await assert.rejects(api.save({displayName:good+'x',avatarData:null,expectedVersion:1,expectedUserId:A}),e=>e.code==='invalid_name');assert.equal(h.calls.filter(x=>x.method==='save_em_dia_own_account_profile').length,1);
});
test('avatar validator accepts only bounded canonical JPEG envelopes and null',()=>{
  assert.equal(Account.validAvatarData(null),true);assert.equal(Account.validAvatarData(JPEG),true);
  for(const value of ['',undefined,'data:image/svg+xml;base64,PHN2Zy8+','data:image/png;base64,abcd',JPEG.replace(/=$/,'A'),JPEG+'=',JPEG.replace('base64,','base64,\n'),JPEG.slice(0,-8)+'AAAAAA==','data:image/jpeg;base64,'+'A'.repeat(140000)])assert.equal(Account.validAvatarData(value),false,String(value).slice(0,45));
});
test('password requests use a captured verified JWT and never send passwords to metadata or local storage',async()=>{
  const h=harness(),api=h.create();await api.load();const result=await api.changePassword({currentPassword:'private-old-fixture',password:'private-new-fixture',nonce:'123456',expectedUserId:A});assert.deepEqual(result,{changed:true,userId:A});const r=h.authRequests[0];assert.equal(r.url,'https://fixture.supabase.co/auth/v1/user');assert.equal(r.method,'PUT');assert.equal(r.headers.Authorization,'Bearer '+h.token(A));assert.deepEqual(JSON.parse(r.body),{password:'private-new-fixture',current_password:'private-old-fixture',nonce:'123456'});assert.ok(h.calls.some(x=>x.method==='getUser'&&x.explicit));assert.doesNotMatch(JSON.stringify(await stored(h.factory)),/private-old-fixture|private-new-fixture|123456|fixture-token|email/);assert.ok(h.calls.every(x=>!JSON.stringify(x.args||{}).includes('private-old-fixture')));
});
test('changing the shared SDK identity after authorization cannot redirect the password request to another user',async()=>{
  const h=harness(),api=h.create();await api.load();h.fetch(async(url,request)=>{assert.equal(request.headers.Authorization,'Bearer '+h.token(A));h.identity(B);return{ok:true,status:200,json:async()=>({id:A})};});await assert.rejects(api.changePassword({currentPassword:'private-old-fixture',password:'private-new-fixture',expectedUserId:A}),e=>e.code==='auth_changed');assert.equal(h.authRequests.length,1);assert.equal((await stored(h.factory,A)).blocked,null);
});
test('a stale password form cannot begin a credential operation under a new account',async()=>{
  const h=harness(),api=h.create();await api.load();h.identity(B);await api.load({expectedUserId:B});await assert.rejects(api.changePassword({currentPassword:'private-old-fixture',password:'private-new-fixture',expectedUserId:A}),e=>e.code==='auth_changed');assert.equal(h.authRequests.length,0);
});
test('current-password, strength and nonce errors remain form errors and never revoke cached account access',async()=>{
  for(const [code,expected,status] of [['current_password_not_valid','current_password_invalid',400],['invalid_credentials','current_password_invalid',401],['weak_password','weak_password',422],['same_password','same_password',422],['reauthentication_needed','reauth_required',400],['reauthentication_not_valid','reauth_required',403]]){const h=harness(),api=h.create();await api.load();h.fetch(async()=>({ok:false,status,json:async()=>({code,msg:'PRIVATE_REQUEST_DUMP'})}));await assert.rejects(api.changePassword({currentPassword:'private-old-fixture',password:'private-new-fixture',expectedUserId:A}),e=>e.code===expected&&!String(e.message).includes('PRIVATE'));assert.equal((await stored(h.factory)).blocked,null);}
});
test('verified Auth endpoint session denial seals only the same account cache',async()=>{
  const h=harness(),api=h.create();await api.load();h.fetch(async()=>({ok:false,status:401,json:async()=>({code:'bad_jwt'})}));await assert.rejects(api.changePassword({currentPassword:'private-old-fixture',password:'private-new-fixture',expectedUserId:A}),Cloud.AuthRequiredError);h.offline();await assert.rejects(h.create().getCached(),Cloud.AccessDeniedError);
});
test('password and nonce actions require explicit clicks and nonce delivery does not retain credentials',async()=>{
  const h=harness(),api=h.create();await api.load();await api.getCached();assert.equal(h.authRequests.length,0);h.fetch(async()=>({ok:true,status:204,json:async()=>{throw Error('No content fixture');}}));assert.deepEqual(await api.requestPasswordNonce({expectedUserId:A}),{requested:true});assert.equal(h.authRequests.length,1);assert.equal(h.authRequests[0].url,'https://fixture.supabase.co/auth/v1/reauthenticate');assert.equal(h.authRequests[0].body,undefined);assert.doesNotMatch(JSON.stringify(await stored(h.factory)),/nonce|access_token|password/);
});
test('a timed-out credential operation is uncertain, never automatically retried, and raw failures are sanitized',async()=>{
  const h=harness(),api=h.create({networkTimeoutMs:5});await api.load();let resolve;h.fetch(()=>new Promise(r=>{resolve=r;}));await assert.rejects(api.changePassword({currentPassword:'private-old-fixture',password:'private-new-fixture',expectedUserId:A}),e=>e.code==='result_unknown'&&!JSON.stringify(e).includes('private'));assert.equal(h.authRequests.length,1);resolve({ok:true,status:200,json:async()=>({id:A})});await new Promise(r=>setImmediate(r));assert.equal(h.authRequests.length,1);assert.equal((await stored(h.factory)).blocked,null);
});
test('nonce delivery failures explain service limits without secrets or automatic repeat',async()=>{
  const h=harness(),api=h.create();await api.load();h.fetch(async()=>{throw {message:'PRIVATE_CREDENTIAL_REQUEST'};});await assert.rejects(api.requestPasswordNonce({expectedUserId:A}),e=>e.code==='nonce_delivery_unknown'&&!e.message.includes('PRIVATE'));assert.equal(h.authRequests.length,1);h.fetch(async()=>({ok:false,status:429,json:async()=>({code:'over_email_send_rate_limit'})}));await assert.rejects(api.requestPasswordNonce({expectedUserId:A}),e=>e.code==='rate_limited');
});
test('invalid password inputs, nonce or Auth configuration never transmit a credential',async()=>{
  const h=harness(),api=h.create();await api.load();for(const input of [{currentPassword:'',password:'private-new-fixture'},{currentPassword:'old-fixture',password:'short'},{currentPassword:'same-fixture',password:'same-fixture'},{currentPassword:'old-fixture',password:'private-new-fixture',nonce:'bad'}])await assert.rejects(api.changePassword({...input,expectedUserId:A}),Account.AccountError);assert.equal(h.authRequests.length,0);const bad=h.create({authUrl:'http://fixture.supabase.co/auth/v1'});await assert.rejects(bad.changePassword({currentPassword:'old-fixture',password:'private-new-fixture',expectedUserId:A}),e=>e.code==='invalid_config');assert.equal(h.authRequests.length,0);
});
test('a success response for an unexpected Auth user cannot be reported as a confirmed password change',async()=>{
  const h=harness(),api=h.create();await api.load();h.fetch(async()=>({ok:true,status:200,json:async()=>({id:B})}));await assert.rejects(api.changePassword({currentPassword:'old-fixture',password:'private-new-fixture',expectedUserId:A}),e=>e.code==='invalid_response');assert.equal(h.authRequests.length,1);
});
function imageEnvironment({width=800,height=600,output=JPEG,fallback=false,drawError=false}={}){
  const observed={closed:0,revoked:[],draw:[],qualities:[],fill:[]};const bitmap={width,height,close(){observed.closed++;}};
  const context={fillRect(...args){observed.fill.push(args);},drawImage(...args){observed.draw.push(args);if(drawError)throw Error('PRIVATE_IMAGE_FIXTURE');}};
  const canvas={getContext:()=>context,toDataURL(type,quality){observed.qualities.push({type,quality});return output;}};
  const environment={document:{createElement(tag){assert.equal(tag,'canvas');return canvas;}},URL:{createObjectURL:()=> 'blob:fixture-private-image',revokeObjectURL:url=>observed.revoked.push(url)}};
  if(fallback)environment.Image=class{constructor(){this.width=width;this.height=height;}set src(value){this.source=value;queueMicrotask(()=>this.onload?.());}};
  else environment.createImageBitmap=async()=>bitmap;
  return {environment,observed,canvas};
}
test('photo preparation crops the center to a small JPEG and releases the decoder',async()=>{
  const h=imageEnvironment();const result=await Account.prepareAvatar({type:'image/png',size:1000},{environment:h.environment});assert.equal(result,JPEG);assert.equal(h.canvas.width,256);assert.equal(h.canvas.height,256);assert.deepEqual(h.observed.draw[0].slice(1),[100,0,600,600,0,0,256,256]);assert.equal(h.observed.qualities[0].type,'image/jpeg');assert.equal(h.observed.closed,1);assert.deepEqual(h.observed.fill[0],[0,0,256,256]);
});
test('the photo fallback revokes its object URL on success and failure',async()=>{
  for(const drawError of [false,true]){const h=imageEnvironment({fallback:true,drawError});const promise=Account.prepareAvatar({type:'image/webp',size:1000},{environment:h.environment});if(drawError)await assert.rejects(promise,e=>e.code==='invalid_image'&&!e.message.includes('PRIVATE'));else assert.equal(await promise,JPEG);assert.deepEqual(h.observed.revoked,['blob:fixture-private-image']);}
});
test('unsupported, oversized or excessively large decoded images fail without retaining image data',async()=>{
  for(const file of [{type:'image/svg+xml',size:100},{type:'image/gif',size:100},{type:'image/jpeg',size:6*1024*1024},{type:'image/png',size:0}])await assert.rejects(Account.prepareAvatar(file),e=>e.code==='invalid_image');const h=imageEnvironment({width:9000,height:9000});await assert.rejects(Account.prepareAvatar({type:'image/jpeg',size:1000},{environment:h.environment}),e=>e.code==='invalid_image');assert.equal(h.observed.closed,1);
});
test('oversized encoded photos try lower quality then fail without returning an unsafe or remote URL',async()=>{
  const h=imageEnvironment({output:'data:image/jpeg;base64,'+'A'.repeat(140000)});await assert.rejects(Account.prepareAvatar({type:'image/jpeg',size:1000},{environment:h.environment}),e=>e.code==='invalid_image');assert.equal(h.observed.qualities.length,3);assert.equal(h.observed.closed,1);
});
