/* Exportação PDF vetorial local. Sem rede ou arquivos de fontes. */
(function(root) {
  'use strict';
  const WIDTHS = [[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,350,556,350,222,556,333,1000,556,556,333,1000,667,333,1000,350,611,350,350,222,222,333,333,350,556,1000,333,1000,500,333,944,350,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,350,556,350,278,556,500,1000,556,556,333,1000,667,333,1000,350,611,350,350,278,278,500,500,350,556,1000,333,1000,556,333,944,350,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556]];
  const WINANSI = {"32":32,"33":33,"34":34,"35":35,"36":36,"37":37,"38":38,"39":39,"40":40,"41":41,"42":42,"43":43,"44":44,"45":45,"46":46,"47":47,"48":48,"49":49,"50":50,"51":51,"52":52,"53":53,"54":54,"55":55,"56":56,"57":57,"58":58,"59":59,"60":60,"61":61,"62":62,"63":63,"64":64,"65":65,"66":66,"67":67,"68":68,"69":69,"70":70,"71":71,"72":72,"73":73,"74":74,"75":75,"76":76,"77":77,"78":78,"79":79,"80":80,"81":81,"82":82,"83":83,"84":84,"85":85,"86":86,"87":87,"88":88,"89":89,"90":90,"91":91,"92":92,"93":93,"94":94,"95":95,"96":96,"97":97,"98":98,"99":99,"100":100,"101":101,"102":102,"103":103,"104":104,"105":105,"106":106,"107":107,"108":108,"109":109,"110":110,"111":111,"112":112,"113":113,"114":114,"115":115,"116":116,"117":117,"118":118,"119":119,"120":120,"121":121,"122":122,"123":123,"124":124,"125":125,"126":126,"127":127,"8364":128,"8218":130,"402":131,"8222":132,"8230":133,"8224":134,"8225":135,"710":136,"8240":137,"352":138,"8249":139,"338":140,"381":142,"8216":145,"8217":146,"8220":147,"8221":148,"8226":149,"8211":150,"8212":151,"732":152,"8482":153,"353":154,"8250":155,"339":156,"382":158,"376":159,"160":160,"161":161,"162":162,"163":163,"164":164,"165":165,"166":166,"167":167,"168":168,"169":169,"170":170,"171":171,"172":172,"173":173,"174":174,"175":175,"176":176,"177":177,"178":178,"179":179,"180":180,"181":181,"182":182,"183":183,"184":184,"185":185,"186":186,"187":187,"188":188,"189":189,"190":190,"191":191,"192":192,"193":193,"194":194,"195":195,"196":196,"197":197,"198":198,"199":199,"200":200,"201":201,"202":202,"203":203,"204":204,"205":205,"206":206,"207":207,"208":208,"209":209,"210":210,"211":211,"212":212,"213":213,"214":214,"215":215,"216":216,"217":217,"218":218,"219":219,"220":220,"221":221,"222":222,"223":223,"224":224,"225":225,"226":226,"227":227,"228":228,"229":229,"230":230,"231":231,"232":232,"233":233,"234":234,"235":235,"236":236,"237":237,"238":238,"239":239,"240":240,"241":241,"242":242,"243":243,"244":244,"245":245,"246":246,"247":247,"248":248,"249":249,"250":250,"251":251,"252":252,"253":253,"254":254,"255":255};
  const n = x => Number(x.toFixed(3)).toString();
  const clean = value => String(value ?? '').normalize('NFC').replace(/[\r\n\t\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
  function bytes(text) {
    return Array.from(clean(text), ch => {
      const cp = ch.codePointAt(0), result = WINANSI[cp];
      if (result === undefined) throw new Error('O PDF não aceita o caractere “' + ch + '”. Remova símbolos ou emojis desse campo e tente novamente. Letras e acentos em português são aceitos.');
      return result;
    });
  }
  const hex = text => bytes(text).map(b => b.toString(16).padStart(2,'0')).join('');
  const width = (text,size,bold=false) => bytes(text).reduce((total,b)=>total+WIDTHS[bold?1:0][b],0)*size/1000;
  function wrap(value, maxWidth, size, bold=false) {
    const text = clean(value), lines = [];
    if (!text) return [];
    let line = '';
    for (const word of text.split(' ')) {
      const joined = line ? line+' '+word : word;
      if (width(joined,size,bold) <= maxWidth) { line=joined; continue; }
      if (line) { lines.push(line); line=''; }
      if (width(word,size,bold) <= maxWidth) { line=word; continue; }
      for (const ch of word) {
        if (line && width(line+ch,size,bold)>maxWidth) { lines.push(line); line=''; }
        line+=ch;
      }
    }
    if (line) lines.push(line);
    return lines;
  }
  class PDF {
    constructor(landscape=false) {
      this.w=landscape?841.89:595.276; this.h=landscape?595.276:841.89;
      this.pages=[]; this.newPage();
    }
    newPage() { this.pages.push([]); this.page=this.pages[this.pages.length-1]; }
    rgb(color) { return color.map(c=>n(c/255)).join(' '); }
    rect(x,y,w,h,fill=[255,255,255],stroke=[188,201,193]) {
      this.page.push('q '+this.rgb(fill)+' rg '+this.rgb(stroke)+' RG 0.4 w '+[x,this.h-y-h,w,h].map(n).join(' ')+' re B Q');
    }
    line(x,y,x2,y2,color=[188,201,193]) {
      this.page.push('q '+this.rgb(color)+' RG 0.4 w '+n(x)+' '+n(this.h-y)+' m '+n(x2)+' '+n(this.h-y2)+' l S Q');
    }
    text(text,x,y,size=8,bold=false,color=[35,51,45]) {
      if(!clean(text))return;
      this.page.push('BT /'+(bold?'F2':'F1')+' '+n(size)+' Tf '+this.rgb(color)+' rg 1 0 0 1 '+n(x)+' '+n(this.h-y-size*.82)+' Tm <'+hex(text)+'> Tj ET');
    }
    serialize(title) {
      const objects=['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'];
      const kids=[];
      for(const commands of this.pages) {
        const pageId=objects.length+1, contentId=pageId+1, content=commands.join('\n')+'\n';
        kids.push(pageId+' 0 R');
        objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 '+n(this.w)+' '+n(this.h)+'] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents '+contentId+' 0 R >>');
        objects.push('<< /Length '+content.length+' >>\nstream\n'+content+'endstream');
      }
      objects[0]='<< /Type /Catalog /Pages 2 0 R /Lang (pt-BR) >>';
      objects[1]='<< /Type /Pages /Kids ['+kids.join(' ')+'] /Count '+kids.length+' >>';
      const titleHex='FEFF'+Array.from(String(title)).map(ch=>{const cp=ch.codePointAt(0);if(cp<=65535)return cp.toString(16).padStart(4,'0');const v=cp-65536;return (55296+(v>>10)).toString(16)+(56320+(v&1023)).toString(16);}).join('');
      objects.push('<< /Title <'+titleHex+'> /Creator (Em dia - Relatorios mensais) /Producer (Em dia PDF local) >>');
      let out='%PDF-1.4\n%EMDIA\n', offsets=[0];
      objects.forEach((obj,i)=>{offsets.push(out.length);out+=(i+1)+' 0 obj\n'+obj+'\nendobj\n';});
      const start=out.length;
      out+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n';
      offsets.slice(1).forEach(off=>out+=String(off).padStart(10,'0')+' 00000 n \n');
      out+='trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R /Info '+objects.length+' 0 R >>\nstartxref\n'+start+'\n%%EOF\n';
      return Uint8Array.from(out,ch=>ch.charCodeAt(0));
    }
  }
function build(spec){
if(!spec.headers?.length||!spec.rows?.length)throw Error('Não há registros para esse relatório.');
const doc=new PDF(!!spec.landscape),margin=34,usable=doc.w-margin*2,size=8.5,lineH=11.5,ratios=spec.widths||spec.headers.map(()=>1),sum=ratios.reduce((a,b)=>a+b,0),col=ratios.map(x=>x/sum*usable),bottom=doc.h-43;
const ink=[26,52,54],brand=[30,102,94],muted=[95,112,113],line=[220,229,225];let y;
function heading(){y=30;doc.text('EM DIA / RELATÓRIOS MENSAIS',margin,y,8.5,true,brand);y+=22;for(const t of wrap(spec.title,usable,19,true)){doc.text(t,margin,y,19,true,ink);y+=23;}y+=3;for(const t of wrap(spec.subtitle||'',usable,9)){doc.text(t,margin,y,9,false,muted);y+=13;}y+=8;}
function tableHead(){const lines=spec.headers.map((h,i)=>wrap(h,col[i]-12,8,true)),h=Math.max(...lines.map(l=>l.length))*11+14;let x=margin;lines.forEach((ls,i)=>{doc.rect(x,y,col[i],h,brand,brand);ls.forEach((t,k)=>doc.text(t,x+6,y+7+k*11,8,true,[255,255,255]));x+=col[i];});y+=h;}
function nextPage(table=true){if(doc.pages.length>=1000)throw Error('Relatório muito extenso. Exporte por publicador.');doc.newPage();heading();if(table)tableHead();}
heading();if(spec.summary){const ls=wrap(spec.summary,usable-20,9,true),h=ls.length*13+20;doc.rect(margin,y,usable,h,[236,245,241],[236,245,241]);ls.forEach((t,i)=>doc.text(t,margin+10,y+10+i*13,9,true,ink));y+=h+16;}tableHead();
spec.rows.forEach((row,index)=>{const cells=spec.headers.map((_,i)=>wrap(row[i]??'',col[i]-12,size,i===0)),count=Math.max(1,...cells.map(c=>c.length));let offset=0;while(offset<count){let available=Math.floor((bottom-y-14)/lineH);if(available<1){nextPage();continue;}let remain=count-offset;if(offset===0&&remain>available&&remain*lineH+14<bottom-185){nextPage();continue;}let take=Math.min(remain,available),h=take*lineH+14,x=margin;cells.forEach((ls,i)=>{doc.rect(x,y,col[i],h,index%2?[245,248,246]:[255,255,255],line);ls.slice(offset,offset+take).forEach((t,k)=>doc.text(t,x+6,y+7+k*lineH,size,i===0,ink));x+=col[i];});y+=h;offset+=take;if(offset<count)nextPage();}});y+=17;
for(const text of spec.notes||[]){const ls=wrap(text,usable,8);if(y+ls.length*12+8>bottom)nextPage(false);for(const t of ls){if(y+12>bottom)nextPage(false);doc.text(t,margin,y,8,false,muted);y+=12;}y+=6;}
doc.pages.forEach((p,i)=>{doc.page=p;doc.line(margin,doc.h-31,doc.w-margin,doc.h-31,line);doc.text('Uso interno. Compartilhe apenas com os responsáveis.',margin,doc.h-23,7,false,muted);const label=(i+1)+' / '+doc.pages.length;doc.text(label,doc.w-margin-width(label,7),doc.h-23,7,true,muted);});return {bytes:doc.serialize(spec.title),pages:doc.pages.length};}
const api={build,wrap,width};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.EmDiaPDF=api;
})(typeof window!=='undefined'?window:globalThis);
