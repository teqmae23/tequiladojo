/* cal-nav.js (自動生成) — テキーラ道場 営業カレンダー 月ナビ共通部品 */
(function(){
var FROM=24317,TO=24324,BASE='https://www.tequiladojo.com/calendar/';
function pad(n){return n<10?'0'+n:''+n;}
function lab(v){var y=Math.floor((v-1)/12),m=((v-1)%12)+1;return{ym:y+pad(m),label:y+'\u5e74'+m+'\u6708'};}
var mm=location.pathname.match(/(\d{4})(\d{2})(calendar|listcal)\.html/);if(!mm)return;
var curYm=mm[1]+mm[2],suffix=mm[3],curVal=(+mm[1])*12+(+mm[2]);
var lo=Math.min(FROM,curVal),hi=Math.max(TO,curVal);
var sel=document.getElementById('cal-month-select');
if(sel){var o='';for(var v=lo;v<=hi;v++){var L=lab(v);o+='<option value="'+L.ym+'"'+(L.ym===curYm?' selected':'')+'>'+L.label+'</option>';}sel.innerHTML=o;}
function arrow(v,g,on){if(on){var L=lab(v);return '<a href="'+BASE+L.ym+suffix+'.html" style="text-decoration:none;padding:4px 12px;border:1px solid #ddd;border-radius:6px;color:#333">'+g+'</a>';}return '<span style="padding:4px 12px;border:1px solid #eee;border-radius:6px;color:#ccc;cursor:default">'+g+'</span>';}
var pv=document.getElementById('cal-prev');if(pv)pv.outerHTML=arrow(curVal-1,'\u2190',(curVal-1)>=FROM);
var nx=document.getElementById('cal-next');if(nx)nx.outerHTML=arrow(curVal+1,'\u2192',(curVal+1)<=TO);
})();
