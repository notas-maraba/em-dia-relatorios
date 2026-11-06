/* Em dia — own account appearance and credential actions. No credential cache. */
(function(root,factory){'use strict';
  const api=factory(typeof module==='object'&&module.exports?require('./cloud.js'):root.EmDiaCloud);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.EmDiaAccount=api;
})(typeof globalThis==='object'?globalThis:this,function(Cloud){'use strict';
  const DB_NAME='em-dia-account-private-v1',STORE='profiles',MAX_AVATAR_LENGTH=140000,MAX_FILE_BYTES=5*1024*1024;
  const copy=value=>JSON.parse(JSON.stringify(value));
  const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const version=value=>Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER;
  class AccountError extends Error{constructor(message,code='account_error'){super(message);this.name='AccountError';this.code=code;}}
  const authRequired=()=>Cloud?new Cloud.AuthRequiredError():new AccountError('Entre novamente para acessar seu perfil.','auth_required');
  const denied=()=>Cloud?new Cloud.AccessDeniedError():new AccountError('Esta conta não tem acesso ao perfil.','access_denied');
  const changed=()=>new AccountError('O acesso mudou durante a operação. Abra novamente seu perfil.','auth_changed');
  const transportError=writing=>new AccountError(writing?'Não foi possível confirmar a operação. Confira o resultado antes de tentar novamente.':'Não foi possível acessar seu perfil. Confira a conexão. ',writing?'result_unknown':'network_error');

  function decodeBase64(value){
    try{
      if(typeof atob==='function')return atob(value);
      if(typeof Buffer!=='undefined')return Buffer.from(value,'base64').toString('binary');
    }catch(_){return null;}return null;
  }
  function validAvatarData(value){
    if(value===null)return true;
    if(typeof value!=='string'||value.length>MAX_AVATAR_LENGTH||!value.startsWith('data:image/jpeg;base64,'))return false;
    const encoded=value.slice(23);
    if(encoded.length<8||encoded.length%4!==0||!(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).test(encoded))return false;
    const bytes=decodeBase64(encoded);
    if(!bytes||bytes.length<5||bytes.charCodeAt(0)!==255||bytes.charCodeAt(1)!==216||bytes.charCodeAt(2)!==255||bytes.charCodeAt(bytes.length-2)!==255||bytes.charCodeAt(bytes.length-1)!==217)return false;
    // Padding bits must be canonical as in PostgreSQL's encode(decode(...)).
    const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    if(encoded.endsWith('==')&&(alphabet.indexOf(encoded.at(-3))&15)!==0)return false;
    if(encoded.endsWith('=')&&!encoded.endsWith('==')&&(alphabet.indexOf(encoded.at(-2))&3)!==0)return false;
    return true;
  }
  function nameInput(value){
    if(typeof value!=='string')throw new AccountError('Informe um nome com até 80 caracteres.','invalid_name');
    const name=value.trim().replace(/\s+/g,' ');
    if([...name].length>80||/[\u0000-\u001f\u007f]/.test(name))throw new AccountError('Informe um nome com até 80 caracteres.','invalid_name');
    return name;
  }
  function profileResult(data,userId){
    const rows=Array.isArray(data)?data:[data],row=rows[0];
    if(rows.length!==1||!object(row)||row.user_id!==userId||typeof row.display_name!=='string'||row.display_name.trim()!==row.display_name||[...row.display_name].length>80||/[\u0000-\u001f\u007f]/.test(row.display_name)||
      !validAvatarData(row.avatar_data)||!version(row.version)||!(row.updated_at===null||typeof row.updated_at==='string'&&Number.isFinite(Date.parse(row.updated_at)))||
      row.version===0&&row.updated_at!==null||row.version>0&&row.updated_at===null)throw new AccountError('O servidor retornou um perfil inválido.','invalid_response');
    return {userId,displayName:row.display_name,avatarData:row.avatar_data,version:row.version,updatedAt:row.updated_at};
  }
  function storedProfile(value,userId){
    if(!object(value)||value.userId!==userId)throw new AccountError('A cópia do perfil não corresponde à conta.','invalid_response');
    return profileResult({user_id:value.userId,display_name:value.displayName,avatar_data:value.avatarData,version:value.version,updated_at:value.updatedAt},userId);
  }
  function mapped(error,writing=false){
    if(error instanceof AccountError||Cloud&&(error instanceof Cloud.AuthRequiredError||error instanceof Cloud.AccessDeniedError||error instanceof Cloud.ConflictError))return error;
    const code=String(error?.code||'');
    if(['reauthentication_needed','reauthentication_not_valid','reauthentication_required'].includes(code))return new AccountError('Confirme o código enviado ao seu e-mail antes de alterar a senha.','reauth_required');
    if(['current_password_not_valid','invalid_credentials','invalid_password'].includes(code))return new AccountError('A senha atual não foi aceita. Confira e tente novamente.','current_password_invalid');
    if(code==='weak_password'||error?.name==='AuthWeakPasswordError')return new AccountError('A nova senha não atende às regras de segurança. Use uma senha mais forte.','weak_password');
    if(code==='same_password')return new AccountError('Escolha uma senha diferente da atual.','same_password');
    if(['over_email_send_rate_limit','over_request_rate_limit','too_many_requests'].includes(code)||error?.status===429)return new AccountError('Aguarde alguns minutos antes de pedir outro código ou tentar novamente.','rate_limited');
    if(['40001','PT409','23505'].includes(code)||error?.status===409)return Cloud?new Cloud.ConflictError():new AccountError('Seu perfil mudou em outro acesso. Recarregue antes de salvar.','conflict');
    if(code==='42501'||error?.status===403)return denied();
    if(error?.status===401||['auth_required','session_not_found','refresh_token_not_found','refresh_token_already_used','bad_jwt','user_not_found'].includes(code)||error?.name==='AuthSessionMissingError')return authRequired();
    if(code==='22023')return new AccountError('Confira o nome e a foto antes de salvar.','invalid_profile');
    return transportError(writing);
  }
  function create({client,indexedDB,identity,online=()=>true,now=()=>Date.now(),networkTimeoutMs=15000,authUrl,publishableKey,fetch:fetcher=globalThis.fetch}={}){
    if(!client?.auth||typeof client.rpc!=='function'||typeof identity!=='function')throw new AccountError('As opções da conta estão indisponíveis.','invalid_client');
    const timeout=Number.isFinite(networkTimeoutMs)&&networkTimeoutMs>0?networkTimeoutMs:15000;
    let databasePromise,memory=null,epoch=0;const accountEpochs=new Map();
    const currentIdentity=async()=>{const value=await identity();return uuid(value)?value:null;};
    const isOnline=()=>online()!==false;
    const ticketFor=userId=>epoch+':'+(accountEpochs.get(userId)||0);
    async function guard(userId,ticket){if(ticket!==ticketFor(userId)||await currentIdentity()!==userId)throw changed();}
    async function context(expectedUserId,requireLoaded=false){
      const userId=expectedUserId||memory?.profile.userId||await currentIdentity();
      if(!uuid(userId))throw authRequired();
      if(await currentIdentity()!==userId)throw changed();
      if(requireLoaded&&!expectedUserId&&memory?.profile.userId!==userId)throw new AccountError('Abra seu perfil novamente antes de continuar.','profile_required');
      return {userId,ticket:ticketFor(userId)};
    }
    function remote(work,writing=false){
      let timer;return Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(transportError(writing)),timeout);})]).finally(()=>clearTimeout(timer));
    }
    function db(){
      if(!indexedDB?.open)return Promise.reject(new AccountError('Este navegador não disponibiliza armazenamento do perfil.','storage_unavailable'));
      if(!databasePromise)databasePromise=new Promise((resolve,reject)=>{
        let request;try{request=indexedDB.open(DB_NAME,1);}catch(_){reject(new AccountError('Não foi possível abrir a cópia privada do perfil.','storage_unavailable'));return;}
        request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE,{keyPath:'userId'});};
        request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
        request.onerror=request.onblocked=()=>reject(new AccountError('Não foi possível abrir a cópia privada do perfil.','storage_unavailable'));
      });return databasePromise;
    }
    async function transact(userId,mutator){
      const database=await db();return new Promise((resolve,reject)=>{
        let tx,result,failure;try{
          try{tx=database.transaction(STORE,mutator?'readwrite':'readonly',mutator?{durability:'strict'}:undefined);}catch(_){tx=database.transaction(STORE,mutator?'readwrite':'readonly');}
          const store=tx.objectStore(STORE),request=store.get(userId);
          request.onsuccess=()=>{try{const old=request.result?copy(request.result):null;result=mutator?mutator(old):old;if(mutator){if(result===null)store.delete(userId);else store.put(result);}}catch(error){failure=error;tx.abort();}};
          request.onerror=()=>{failure=new AccountError('Não foi possível ler a cópia privada do perfil.','storage_error');};
          tx.oncomplete=()=>resolve(result?copy(result):null);
          tx.onabort=tx.onerror=()=>reject(failure||new AccountError('Não foi possível guardar a foto neste aparelho. Confira o espaço disponível.','storage_error'));
        }catch(_){reject(new AccountError('Não foi possível guardar a cópia do perfil neste aparelho.','storage_error'));}
      });
    }
    async function seal(userId,reason,ticket){
      if(ticket!==ticketFor(userId)||await currentIdentity()!==userId)return;
      memory=null;
      try{await transact(userId,old=>{if(ticket!==ticketFor(userId))return old;return {userId,profile:old?.profile||null,blocked:reason,generation:generation(old)+1};});}catch(_){/* An unavailable store also cannot supply an offline profile. */}
    }
    async function fail(error,userId,ticket,writing=false){
      const result=mapped(error,writing);
      if(['auth_required','access_denied'].includes(result.code)){await seal(userId,result.code,ticket);result.globalAccessLost=true;}
      return result;
    }
    async function verify(userId,ticket,accessToken){
      await guard(userId,ticket);
      const auth=await remote(()=>accessToken===undefined?client.auth.getUser():client.auth.getUser(accessToken));
      await guard(userId,ticket);if(auth?.error)throw auth.error;
      if(auth?.data?.user?.id!==userId)throw changed();
      const response=await remote(()=>client.rpc('get_em_dia_access_profile'));
      await guard(userId,ticket);if(response?.error)throw response.error;
      const raw=Array.isArray(response.data)?response.data[0]:response.data;
      if(!object(raw)||raw.user_id!==userId||!['admin','superintendent','publisher'].includes(raw.role)||
        raw.is_admin!==undefined&&raw.is_admin!==(raw.role==='admin'))throw denied();
      return raw;
    }
    const generation=row=>Number.isSafeInteger(row?.generation)&&row.generation>=0?row.generation:0;
    async function captureGeneration(userId,ticket){try{const row=await transact(userId);await guard(userId,ticket);return generation(row);}catch(error){if(error.code==='auth_changed')throw error;return null;}}
    async function cache(profile,userId,ticket,expectedGeneration){
      await guard(userId,ticket);let cacheAvailable=true,selected=profile;
      try{
        if(expectedGeneration===null)throw new AccountError('A cópia deste aparelho não pôde ser conferida.','storage_error');
        const row=await transact(userId,old=>{
          if(ticket!==ticketFor(userId))throw changed();
          if(generation(old)!==expectedGeneration)throw changed();
          if(old?.profile){try{const previous=storedProfile(old.profile,userId);if(previous.version>profile.version)return {...old,blocked:null};}catch(_){/* A verified response replaces an unusable private cache. */}}
          return {userId,profile:copy(profile),blocked:null,generation:expectedGeneration};
        });
        await guard(userId,ticket);
        if(row?.blocked)throw denied();selected=storedProfile(row.profile,userId);
      }catch(error){if(error?.code==='auth_changed'||error?.code==='access_denied'||error?.code==='invalid_response')throw error;cacheAvailable=false;}
      await guard(userId,ticket);memory={profile:copy(selected),cacheAvailable,generation:expectedGeneration};return {...copy(selected),cached:false,cacheAvailable,...(!cacheAvailable?{cacheWarning:'O perfil foi confirmado na nuvem, mas a cópia deste aparelho não pôde ser atualizada.'}:{})};
    }
    async function getCached({expectedUserId}={}){
      const identityId=await currentIdentity();if(!identityId){memory=null;return null;}
      const {userId,ticket}=await context(expectedUserId||identityId);
      let row;
      try{row=await transact(userId);}catch(error){await guard(userId,ticket);if(memory?.profile.userId===userId)return {...copy(memory.profile),cached:true,cacheAvailable:false};throw error;}
      await guard(userId,ticket);
      if(row?.blocked){memory=null;throw denied();}
      if(row&&!row.profile){memory=null;return null;}
      if(!row?.profile){if(memory?.profile.userId===userId)return {...copy(memory.profile),cached:true,cacheAvailable:memory.cacheAvailable};return null;}
      const profile=storedProfile(row.profile,userId);
      if(memory?.profile.userId===userId&&memory.generation===generation(row)&&memory.profile.version>profile.version)return {...copy(memory.profile),cached:true,cacheAvailable:false};
      memory={profile,cacheAvailable:true,generation:generation(row)};return {...copy(profile),cached:true,cacheAvailable:true};
    }
    async function load({refresh=true,expectedUserId}={}){
      const identityId=await currentIdentity();if(!identityId){memory=null;return null;}
      const {userId,ticket}=await context(expectedUserId||identityId);let previous=null;
      try{previous=await getCached({expectedUserId:userId});}catch(error){if(!['storage_error','storage_unavailable','invalid_response','auth_required','access_denied'].includes(error.code))throw error;if(!isOnline())throw error;}
      await guard(userId,ticket);if(!refresh||!isOnline())return previous;
      try{
        const expectedGeneration=await captureGeneration(userId,ticket);
        await verify(userId,ticket);const response=await remote(()=>client.rpc('read_em_dia_own_account_profile',{p_expected_user_id:userId}));
        await guard(userId,ticket);if(response?.error)throw response.error;const result=profileResult(response.data,userId);return await cache(result,userId,ticket,expectedGeneration);
      }catch(error){const result=await fail(error,userId,ticket);if(result.code==='network_error'&&previous){await guard(userId,ticket);return {...previous,cached:true,stale:true};}throw result;}
    }
    async function save({displayName,avatarData,expectedVersion,expectedUserId}={}){
      if(!isOnline())throw new AccountError('Conecte-se à internet para alterar o nome ou a foto.','online_required');
      const name=nameInput(displayName);if(!validAvatarData(avatarData))throw new AccountError('Escolha uma foto JPEG válida e menor.','invalid_avatar');
      if(!version(expectedVersion))throw new AccountError('Recarregue seu perfil antes de salvar.','invalid_version');
      const {userId,ticket}=await context(expectedUserId,true);
      try{
        const expectedGeneration=await captureGeneration(userId,ticket);
        await verify(userId,ticket);const response=await remote(()=>client.rpc('save_em_dia_own_account_profile',{
          p_display_name:name,p_avatar_data:avatarData,p_expected_version:expectedVersion,p_expected_user_id:userId
        }),true);
        await guard(userId,ticket);if(response?.error)throw response.error;const result=profileResult(response.data,userId);
        if(result.displayName!==name||result.avatarData!==avatarData||!(result.version===expectedVersion||result.version===expectedVersion+1))throw new AccountError('Não foi possível confirmar o perfil salvo. Recarregue antes de repetir.','invalid_response');
        return {...await cache(result,userId,ticket,expectedGeneration),confirmed:true};
      }catch(error){throw await fail(error,userId,ticket,true);}
    }
    function authConfig(){
      let base;try{base=new URL(authUrl);}catch(_){throw new AccountError('A troca de senha não está configurada.','invalid_config');}
      if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||!base.pathname.endsWith('/auth/v1')||
        typeof publishableKey!=='string'||!publishableKey||/[\r\n]/.test(publishableKey)||typeof fetcher!=='function')throw new AccountError('A troca de senha não está configurada.','invalid_config');
      return base.href.replace(/\/$/,'');
    }
    async function tokenContext(expectedUserId){
      if(!isOnline())throw new AccountError('Conecte-se à internet para alterar a senha.','online_required');
      const contextValue=await context(expectedUserId,true),{userId,ticket}=contextValue;
      try{
        const response=await remote(()=>client.auth.getSession());await guard(userId,ticket);if(response?.error)throw response.error;
        const session=response?.data?.session,accessToken=session?.access_token;
        if(session?.user?.id!==userId)throw changed();
        if(typeof accessToken!=='string'||!accessToken||accessToken.length>16384||/[\r\n]/.test(accessToken))throw authRequired();
        await verify(userId,ticket,accessToken);return {...contextValue,accessToken};
      }catch(error){throw await fail(error,userId,ticket);}
    }
    async function authRequest(path,method,body,ctx){
      const base=authConfig(),{userId,ticket,accessToken}=ctx;await guard(userId,ticket);
      const controller=typeof AbortController==='function'?new AbortController():null;let abortTimer;
      try{
        const request={method,headers:{apikey:publishableKey,Authorization:'Bearer '+accessToken,'Content-Type':'application/json'},credentials:'omit',cache:'no-store',redirect:'error',...(controller?{signal:controller.signal}:{})};
        if(body!==null)request.body=JSON.stringify(body);
        abortTimer=setTimeout(()=>controller?.abort(),timeout);
        const response=await remote(()=>fetcher(base+path,request),true);
        let data;try{data=response.status===204?{}:await remote(()=>response.json(),true);}catch(_){throw transportError(true);}
        if(!response.ok)throw {code:typeof data?.code==='string'?data.code:'',status:response.status};
        await guard(userId,ticket);return data;
      }catch(error){throw await fail(error,userId,ticket,true);}
      finally{clearTimeout(abortTimer);}
    }
    async function changePassword({currentPassword,password,nonce,expectedUserId}={}){
      if(typeof currentPassword!=='string'||!currentPassword||currentPassword.length>4096||typeof password!=='string'||password.length<8||password.length>4096||password===currentPassword)throw new AccountError('Informe a senha atual e uma nova senha diferente, com pelo menos 8 caracteres.','invalid_password');
      if(nonce!==undefined&&nonce!==null&&(typeof nonce!=='string'||!/^\d{6,10}$/.test(nonce)))throw new AccountError('Confira o código recebido por e-mail.','invalid_nonce');
      const ctx=await tokenContext(expectedUserId),body={password,current_password:currentPassword};if(nonce)body.nonce=nonce;
      try{const result=await authRequest('/user','PUT',body,ctx),user=result?.user||result;if(!object(user)||user.id!==ctx.userId)throw new AccountError('Não foi possível confirmar a alteração de senha. Entre novamente antes de repetir.','invalid_response');return {changed:true,userId:ctx.userId};}
      finally{body.password='';body.current_password='';if(body.nonce)body.nonce='';}
    }
    async function requestPasswordNonce({expectedUserId}={}){
      const ctx=await tokenContext(expectedUserId);
      try{await authRequest('/reauthenticate','GET',null,ctx);return {requested:true};}
      catch(error){if(['result_unknown','network_error'].includes(error.code))throw new AccountError('Não foi possível confirmar o envio do código. Confira seu e-mail antes de pedir outro; o serviço pode ter limites de envio.','nonce_delivery_unknown');throw error;}
    }
    function clearMemory(){epoch++;accountEpochs.clear();memory=null;}
    async function forget(userId){if(!uuid(userId))return;accountEpochs.set(userId,(accountEpochs.get(userId)||0)+1);if(memory?.profile.userId===userId)memory=null;await transact(userId,old=>({userId,profile:null,blocked:null,generation:generation(old)+1}));}
    return Object.freeze({load,getCached,save,changePassword,requestPasswordNonce,clearMemory,forget});
  }
  async function prepareAvatar(file,{environment=globalThis}={}){
    if(!file||!['image/jpeg','image/png','image/webp'].includes(file.type)||!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_FILE_BYTES)throw new AccountError('Escolha uma foto JPEG, PNG ou WebP de até 5 MB.','invalid_image');
    let image,url,timer,finished=false;
    const invalid=()=>new AccountError('Não foi possível preparar esta foto. Escolha uma imagem menor e tente novamente.','invalid_image');
    try{
      if(typeof environment.createImageBitmap==='function')image=await Promise.race([Promise.resolve(environment.createImageBitmap(file,{imageOrientation:'from-image'})).then(value=>{if(finished){value.close?.();throw invalid();}return value;}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(invalid()),15000);})]);
      else{
        if(!environment.URL?.createObjectURL||!environment.Image)throw invalid();
        url=environment.URL.createObjectURL(file);image=new environment.Image();
        await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(invalid()),15000);image.onload=resolve;image.onerror=()=>reject(invalid());image.src=url;});
      }
      clearTimeout(timer);const width=image.width||image.naturalWidth,height=image.height||image.naturalHeight;
      if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>8192||height>8192||width*height>33554432)throw invalid();
      const canvas=environment.document?.createElement('canvas');if(!canvas)throw invalid();canvas.width=canvas.height=256;
      const context=canvas.getContext('2d');if(!context)throw invalid();context.fillStyle='#ffffff';context.fillRect(0,0,256,256);
      const side=Math.min(width,height);context.drawImage(image,(width-side)/2,(height-side)/2,side,side,0,0,256,256);
      for(const quality of [0.86,0.76,0.66]){const output=canvas.toDataURL('image/jpeg',quality);if(validAvatarData(output))return output;}
      throw invalid();
    }catch(_){throw invalid();}
    finally{finished=true;clearTimeout(timer);try{image?.close?.();if(image&&'onload'in image){image.onload=null;image.onerror=null;}if(url)environment.URL.revokeObjectURL?.(url);}catch(_){/* Releasing a decoder must not expose its private source. */}}
  }
  return Object.freeze({create,prepareAvatar,validAvatarData,AccountError,limits:Object.freeze({maxAvatarLength:MAX_AVATAR_LENGTH,maxFileBytes:MAX_FILE_BYTES,avatarSize:256})});
});
