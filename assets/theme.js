/* Em dia: a device preference only. No account data belongs in this storage. */
(function(root,factory){'use strict';
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{root.EmDiaTheme=api;api.init();}
})(typeof window==='object'?window:globalThis,function(root){'use strict';
  const KEY='em-dia-theme-v1',listeners=new Set();
  let theme='light',initialized=false;
  const valid=value=>value==='light'||value==='dark';
  function notify(){for(const listener of listeners){try{listener(theme);}catch(_){/* A view must not interrupt theme changes. */}}}
  function paint(value,persist){
    if(!valid(value))throw new TypeError('Escolha um tema claro ou escuro.');
    const changed=theme!==value;theme=value;
    const html=root.document?.documentElement;
    if(html){html.dataset.theme=value;html.style.colorScheme=value;}
    const meta=root.document?.querySelector?.('meta[name="theme-color"]');
    if(meta)meta.setAttribute('content',value==='dark'?'#0d1b1e':'#ffffff');
    if(persist){try{root.localStorage?.setItem(KEY,value);}catch(_){/* The theme still works when device storage is unavailable. */}}
    if(changed)notify();
    return theme;
  }
  function init(){
    if(initialized)return theme;initialized=true;
    let saved=null;try{saved=root.localStorage?.getItem(KEY);}catch(_){/* Default to the original light appearance. */}
    paint(valid(saved)?saved:'light',false);
    root.addEventListener?.('storage',event=>{if(event.key===KEY)paint(valid(event.newValue)?event.newValue:'light',false);});
    return theme;
  }
  function current(){return theme;}
  function apply(value){init();return paint(value,true);}
  function toggle(){init();return paint(theme==='dark'?'light':'dark',true);}
  function subscribe(listener){if(typeof listener!=='function')throw new TypeError('Uma função é necessária.');init();listeners.add(listener);try{listener(theme);}catch(_){/* Keep the appearance available if a view failed to initialize. */}return()=>listeners.delete(listener);}
  return Object.freeze({init,current,apply,toggle,subscribe});
});
