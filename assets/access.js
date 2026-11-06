/* Em dia — explicit device login preferences. */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.EmDiaAccess=api;})(typeof globalThis==='object'?globalThis:this,function(){'use strict';
  const AUTH_KEY='em-dia-auth-v1',PREF_KEY='em-dia-access-preferences-v1',GEN_KEY='em-dia-auth-generation-v1';
  const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const emailInput=value=>{const email=typeof value==='string'?value.trim():'';if(email.length>254||!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(email))throw new AccessError('Informe um e-mail válido.','invalid_email');return email;};
  class AccessError extends Error{constructor(message,code='access_error'){super(message);this.name='AccessError';this.code=code;}}
  const storageError=()=>new AccessError('Não foi possível guardar a preferência de acesso neste aparelho. Libere o armazenamento do navegador e tente novamente.','storage_unavailable');
  const changed=()=>new AccessError('O acesso mudou em outra aba. Recarregue a página antes de continuar.','auth_changed');
  function create({localStorage:local,sessionStorage:tab,random=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)}={}){
    if(local===undefined)try{local=globalThis.localStorage;}catch(_){local=null;}
    if(tab===undefined)try{tab=globalThis.sessionStorage;}catch(_){tab=null;}
    let generation,mode=false,storageAvailable=true;
    const get=(store,key)=>{try{if(!store||typeof store.getItem!=='function')throw storageError();return store.getItem(key);}catch(_){throw storageError();}};
    const put=(store,key,value)=>{try{if(!store||typeof store.setItem!=='function')throw storageError();store.setItem(key,value);if(store.getItem(key)!==value)throw storageError();}catch(_){throw storageError();}};
    const remove=(store,key)=>{try{if(!store||typeof store.removeItem!=='function')throw storageError();store.removeItem(key);if(store.getItem(key)!==null)throw storageError();}catch(_){throw storageError();}};
    function savedPreferences(){let parsed;try{parsed=JSON.parse(get(local,PREF_KEY)||'null');}catch(error){if(error instanceof AccessError)throw error;return null;}return parsed&&parsed.version===1&&typeof parsed.stayConnected==='boolean'&&typeof parsed.rememberEmail==='boolean'?parsed:null;}
    try{generation=get(local,GEN_KEY);const p=savedPreferences();mode=p?p.stayConnected:!!get(local,AUTH_KEY);}catch(_){storageAvailable=false;generation=null;}
    const checkGeneration=()=>{if(!storageAvailable)throw storageError();if(get(local,GEN_KEY)!==generation)throw changed();};
    const validKey=key=>{if(typeof key!=='string'||!(key===AUTH_KEY||key.startsWith(AUTH_KEY+'-')))throw new AccessError('Chave de sessão inválida.','invalid_storage_key');};
    const selected=()=>mode?local:tab;
    const storage=Object.freeze({
      getItem(key){validKey(key);try{checkGeneration();return get(selected(),key);}catch(error){if(error.code==='auth_changed')return null;throw error;}},
      setItem(key,value){validKey(key);checkGeneration();if(typeof value!=='string')throw storageError();put(selected(),key,value);},
      removeItem(key){validKey(key);checkGeneration();remove(selected(),key);if(key===AUTH_KEY){remove(mode?tab:local,key);const next=String(random());put(local,GEN_KEY,next);generation=next;}}
    });
    function preferences(){try{const p=savedPreferences();let email='';if(p?.rememberEmail)try{email=emailInput(p.email);}catch(_){}return {rememberEmail:!!p?.rememberEmail&&!!email,email,stayConnected:mode,storageAvailable};}catch(_){return {rememberEmail:false,email:'',stayConnected:mode,storageAvailable:false};}}
    function writePreferences(patch){checkGeneration();const previous=savedPreferences()||{version:1,stayConnected:mode,rememberEmail:false,email:''};put(local,PREF_KEY,JSON.stringify({...previous,...patch,version:1}));}
    function prepareLogin({stayConnected=false}={}){
      if(typeof stayConnected!=='boolean')throw new AccessError('Confira a preferência de acesso.','invalid_preference');
      // A deliberate new login may recover an adapter invalidated by another tab.
      const current=get(local,GEN_KEY),next=String(random()),previous=savedPreferences()||{version:1,rememberEmail:false,email:''};
      // Probe destination before changing existing credentials. Session-only never falls back to local storage.
      const destination=stayConnected?local:tab,probe=AUTH_KEY+'-storage-probe';put(destination,probe,'1');remove(destination,probe);
      for(const key of [AUTH_KEY,AUTH_KEY+'-user',AUTH_KEY+'-code-verifier']){remove(local,key);remove(tab,key);}
      put(local,PREF_KEY,JSON.stringify({...previous,version:1,stayConnected}));put(local,GEN_KEY,next);
      generation=next;mode=stayConnected;storageAvailable=true;return {stayConnected:mode,previousGeneration:current!==null};
    }
    function identity(){try{const session=JSON.parse(storage.getItem(AUTH_KEY)||'null');return uuid(session?.user?.id)?session.user.id:null;}catch(_){return null;}}
    function rememberSuccessfulEmail(email,remember){if(typeof remember!=='boolean')throw new AccessError('Confira a preferência de e-mail.','invalid_preference');const value=remember?emailInput(email):'';writePreferences({rememberEmail:remember,email:value});return {remembered:remember};}
    function forgetRememberedEmail(){writePreferences({rememberEmail:false,email:''});}
    return Object.freeze({storage,identity,preferences,prepareLogin,rememberSuccessfulEmail,forgetRememberedEmail});
  }
  return Object.freeze({create,AccessError,AUTH_KEY,PREF_KEY,GEN_KEY});
});
