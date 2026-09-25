/* sched-groups.js — イベントスケジュールの「班」（最大3班）共通ロジック
 * admin_events.html / event.html / tddt2026.html で共有。
 *
 * scheduleItems の追加フィールド（すべて任意。未設定なら従来どおり1班のみ）
 *   group        : 1|2|3            この項目が属する班（未設定=1）
 *   groupOp      : ''|'split'|'merge'
 *                  split … 離脱。groupMembers を groupFrom → groupTo へ移動
 *                  merge … 合流。groupFrom の全員を groupTo へ移し、groupFrom はここで終了
 *   groupFrom    : 1..3
 *   groupTo      : 1..3
 *   groupMembers : [{id,name}]       split のみ
 * 表示: 1班はメインのタイムライン。2班/3班はアクティブな日の右端に細い縦バー → クリックで展開。
 */
(function(w){
  'use strict';
  var MAX=3;
  var META={
    1:{name:'1班',color:'#7a5610',bg:'#fbf3e0'},
    2:{name:'2班',color:'#1a6e58',bg:'#e6f4ef'},
    3:{name:'3班',color:'#6a3fa0',bg:'#f1ebf9'}
  };
  function num(v){ var n=parseInt(v,10); return (n>=1&&n<=MAX)?n:0; }
  function op(it){
    if(!it) return '';
    var o=it.groupOp; if(o!=='split'&&o!=='merge') return '';
    var f=num(it.groupFrom), t=num(it.groupTo);
    if(!f||!t||f===t) return '';
    return o;
  }
  // 項目の所属班（split=離脱元、merge=合流先、それ以外=group）
  function owner(it){
    var o=op(it);
    if(o==='split') return num(it.groupFrom);
    if(o==='merge') return num(it.groupTo);
    return num(it&&it.group)||1;
  }
  // 項目を表示する班の一覧 [{g, mirror}]（mirror=相手側の班に出す簡易表示）
  function cols(it){
    var o=op(it), r=[{g:owner(it),mirror:false}];
    if(o==='split') r.push({g:num(it.groupTo),mirror:true});
    else if(o==='merge') r.push({g:num(it.groupFrom),mirror:true});
    return r;
  }
  function inGroup(it,g){ return cols(it).some(function(c){ return c.g===g; }); }
  // 班機能を使っているか（使っていなければ従来表示のまま）
  function used(items){ return (items||[]).some(function(it){ return owner(it)!==1 || op(it)!==''; }); }
  // list: 時系列順の [{it, day, markOnly}] → {day:{g:true}} その日にアクティブな班
  function activeByDay(list){
    var act={}, res={};
    (list||[]).forEach(function(x){
      var it=x.it, d=x.day||'';
      var s=res[d]||(res[d]={});
      Object.keys(act).forEach(function(k){ s[k]=true; });
      cols(it).forEach(function(c){ s[c.g]=true; });
      if(x.markOnly) return;
      var o=op(it);
      if(o==='split') act[num(it.groupTo)]=true;
      else if(o==='merge'){ delete act[num(it.groupFrom)]; }
      else { var g=owner(it); if(g!==1) act[g]=true; }
    });
    return res;
  }
  // list: 時系列順の [{it, day, markOnly, ...}] を「ブロック」に分割して返す。
  // ブロックは同一日付内で、その時間帯が単独班か別班併存かで切れる:
  //   {day, multi:false, items:[...]}                 … 単独班（サイドバー無し・従来表示）
  //   {day, multi:true, active:{2:true,..}, items:[]} … 別班併存（サイドバー付きの複数列）
  // 別班の有効状態(act)は日をまたいで継続する（離脱→合流までの間）。
  function segment(list){
    var act={}, blocks=[], cur=null;
    (list||[]).forEach(function(x){
      var it=x.it, o=op(it);
      var sidesNow=Object.assign({}, act);
      if(!x.markOnly){
        if(o==='split') sidesNow[num(it.groupTo)]=true;
        else if(o==='merge'){ /* 合流時は groupFrom もまだ併存 */ }
        else { var g=owner(it); if(g!==1) sidesNow[g]=true; }
      }
      var multi=Object.keys(sidesNow).length>0;
      var day=x.day||'';
      if(!cur || cur.day!==day || cur.multi!==multi){
        cur={day:day, multi:multi, active:{}, items:[]}; blocks.push(cur);
      }
      cur.items.push(x);
      if(multi) Object.keys(sidesNow).forEach(function(k){ cur.active[k]=true; });
      if(!x.markOnly){
        if(o==='split') act[num(it.groupTo)]=true;
        else if(o==='merge') delete act[num(it.groupFrom)];
        else { var g2=owner(it); if(g2!==1) act[g2]=true; }
      }
    });
    return blocks;
  }
  // 各項目時点の班別メンバー { itemId: {1:{key:name},2:{..},3:{..}} }
  // keyOf(np) → {key,name}|null / labelOp(it) → 'join'|'leave'|''（従来の合流/離脱ラベル）
  function rosters(list, keyOf, labelOp){
    var cur={1:{},2:{},3:{}}, map={};
    function rm(k){ for(var g=1;g<=MAX;g++) delete cur[g][k]; }
    function put(g,p){ if(!(p.key in cur[g])) rm(p.key); cur[g][p.key]=p.name; }
    (list||[]).forEach(function(x){
      var it=x.it, o=op(it);
      if(o==='split'){
        var t=num(it.groupTo);
        (it.groupMembers||[]).forEach(function(np){ var p=keyOf(np); if(p) put(t,p); });
      } else if(o==='merge'){
        var f=num(it.groupFrom), t2=num(it.groupTo);
        Object.keys(cur[f]).forEach(function(k){ cur[t2][k]=cur[f][k]; });
        cur[f]={};
      } else {
        var lo=labelOp?labelOp(it):'', g=owner(it);
        if(lo==='join') (it.nameParticipants||[]).forEach(function(np){ var p=keyOf(np); if(p) put(g,p); });
        else if(lo==='leave') (it.nameParticipants||[]).forEach(function(np){ var p=keyOf(np); if(p) rm(p.key); });
      }
      var snap={}; for(var g2=1;g2<=MAX;g2++){ snap[g2]=Object.assign({},cur[g2]); }
      map[it.id]=snap;
    });
    return map;
  }
  // 指定日時(dateStr,timeStr)の「直前」時点でアクティブな別班を返す {2:true,3:true}
  // ＝過去に離脱(split)があり、まだ合流(merge)していない班。excludeId は編集中の自分を除外。
  function activeAt(items, dateStr, timeStr, excludeId){
    var ref=(dateStr||'')+' '+(timeStr||'');
    var prior=(items||[]).filter(function(it){
      if(excludeId && it.id===excludeId) return false;
      return ((it.date||'')+' '+(it.time||'')) < ref;
    }).sort(function(a,b){
      var ka=(a.date||'')+' '+(a.time||''), kb=(b.date||'')+' '+(b.time||'');
      return ka<kb?-1:(ka>kb?1:0);
    });
    var act={};
    prior.forEach(function(it){
      var o=op(it);
      if(o==='split') act[num(it.groupTo)]=true;
      else if(o==='merge') delete act[num(it.groupFrom)];
      else { var g=owner(it); if(g!==1) act[g]=true; }
    });
    return act;
  }
  function groupOfKey(snap, key){
    if(!snap||!key) return 0;
    for(var g=1;g<=MAX;g++){ if(snap[g] && (key in snap[g])) return g; }
    return 0;
  }
  function _names(it){ return (it.groupMembers||[]).map(function(x){ return (x&&(x.name||x.id))||''; }).filter(Boolean); }
  // 所属班側のタイトル横バッジ
  function badge(it, esc){
    var o=op(it); if(!o) return '';
    var f=num(it.groupFrom), t=num(it.groupTo), nm=_names(it);
    var txt=(o==='split')
      ? '✂ '+META[f].name+'→'+META[t].name+' 離脱'+(nm.length?'：'+nm.join('、'):'')
      : '🔗 '+META[f].name+'→'+META[t].name+' 合流';
    return '<span class="sg-badge" style="background:'+META[o==='split'?t:f].color+'">'+esc(txt)+'</span>';
  }
  // 相手側の班に出す簡易行
  function mirrorHtml(it, esc, attrs){
    var o=op(it), f=num(it.groupFrom), t=num(it.groupTo), nm=_names(it);
    var head=(o==='split')
      ? '✂ '+META[f].name+'から移動'+(nm.length?'：'+nm.join('、'):'')
      : '🔗 '+META[t].name+'へ合流（'+META[f].name+'はここまで）';
    var tm=it.time||'—';
    return '<div class="sg-mirror"'+(attrs||'')+'><span class="sg-mt">'+esc(tm)+'</span>'
      +'<div class="sg-mb"><div class="sg-mh">'+esc(head)+'</div>'+(it.title?'<div class="sg-ms">'+esc(it.title)+'</div>':'')+'</div></div>';
  }
  // colsHtml:{1:'',2:'',3:''} / active:{g:true} / opts.paneHead(g)→ペイン見出し右側に置くHTML
  // 別班がある日は列を横並びにし、「今アクティブな班」だけを主役の幅にして、他班(1班含む)は細い縦バーに畳む。
  function _colHtml(g, inner, ph){
    var m=META[g];
    return '<div class="sg-col" data-g="'+g+'" style="--sg-c:'+m.color+';--sg-bg:'+m.bg+'">'
      +'<button type="button" class="sg-bar" title="'+m.name+'を開く" onclick="event.stopPropagation();SchedGroups.setActive('+g+')"><span>'+m.name+'</span></button>'
      +'<div class="sg-pane"><div class="sg-pane-hd"><span>'+m.name+'</span>'+(ph||'')+'</div>'
      +(inner||'<div class="sg-empty">この日の'+m.name+'の予定なし</div>')+'</div></div>';
  }
  function wrapHtml(colsHtml, active, opts){
    opts=opts||{};
    var sides=[2,3].filter(function(g){ return active&&active[g]; });
    if(!sides.length) return colsHtml[1]||'';   // 別班が無い日は従来どおり1班のみ
    var ph=function(g){ return opts.paneHead?(opts.paneHead(g)||''):''; };
    var h='<div class="sg-wrap">';
    [1].concat(sides).forEach(function(g){ h+=_colHtml(g, colsHtml[g], ph(g)); });
    return h+'</div>';
  }
  // アクティブな班を切替（全日共通・body クラスで保持。既定=1班）。別班を開くと1班は自動でバーに畳む。
  function setActive(g){
    g=num(g)||1; var b=document.body;
    b.classList.remove('sg-active-2','sg-active-3','sg-any-open');
    if(g!==1){ b.classList.add('sg-active-'+g,'sg-any-open'); }
    if(g!==1) setTimeout(function(){
      Array.prototype.forEach.call(document.querySelectorAll('.sg-col[data-g="'+g+'"]'),function(s){
        var wr=s.parentNode; if(wr && wr.scrollWidth>wr.clientWidth) wr.scrollLeft=Math.max(0, s.offsetLeft-8);
      });
    },30);
  }
  function toggle(g){ setActive(g); }         // 後方互換
  function closeAll(){ setActive(1); }
  var CSS=''
    +'.sg-wrap{display:flex;align-items:stretch;gap:6px;position:relative;overflow-x:auto;-webkit-overflow-scrolling:touch}'
    +'.sg-col{display:flex;align-items:stretch;flex:0 0 auto;min-width:0}'
    +'.sg-bar{flex:0 0 16px;width:16px;min-height:44px;border:none;border-radius:7px;background:var(--sg-c);opacity:.55;cursor:pointer;padding:0;display:flex;align-items:flex-start;justify-content:center;font-family:inherit}'
    +'.sg-bar:hover{opacity:.9}'
    +'.sg-bar span{writing-mode:vertical-rl;text-orientation:upright;color:#fff;font-size:10px;font-weight:700;letter-spacing:.12em;padding:8px 0;line-height:16px}'
    +'.sg-col .sg-bar{display:flex}'
    +'.sg-col .sg-pane{display:none;min-width:0;flex:1 1 auto}'
    +'.sg-pane-hd{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;margin-bottom:6px;color:var(--sg-c)}'
    +'.sg-pane-hd>span{flex:1}'
    /* 既定(別班未アクティブ)=1班を主役に、他班はバー */
    +'body:not(.sg-active-2):not(.sg-active-3) .sg-col[data-g="1"]{flex:1 1 0;min-width:200px}'
    +'body:not(.sg-active-2):not(.sg-active-3) .sg-col[data-g="1"] .sg-bar{display:none}'
    +'body:not(.sg-active-2):not(.sg-active-3) .sg-col[data-g="1"] .sg-pane{display:block}'
    /* 別班をアクティブにしたら、その班を主役に・1班と他班はバーに畳む */
    +'body.sg-active-2 .sg-col[data-g="2"],body.sg-active-3 .sg-col[data-g="3"]{flex:1 1 0;min-width:200px}'
    +'body.sg-active-2 .sg-col[data-g="2"] .sg-bar,body.sg-active-3 .sg-col[data-g="3"] .sg-bar{display:none}'
    +'body.sg-active-2 .sg-col[data-g="2"] .sg-pane,body.sg-active-3 .sg-col[data-g="3"] .sg-pane{display:block;padding:6px;border-radius:10px;background:var(--sg-bg);border:1px solid var(--sg-c)}'
    +'.sg-empty{font-size:11px;color:#8a8478;padding:8px 4px}'
    +'.sg-badge{display:inline-block;color:#fff;font-size:10.5px;font-weight:700;padding:1px 8px;border-radius:9px;margin-left:6px;vertical-align:middle;white-space:normal}'
    +'.sg-mirror{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px dashed var(--sg-c,#999);border-radius:10px;margin-bottom:8px;background:rgba(255,255,255,.75);font-size:12px}'
    +'.sg-mt{min-width:44px;text-align:center;font-weight:700;font-size:14px;flex:0 0 auto}'
    +'.sg-mb{min-width:0}'
    +'.sg-mh{font-weight:700;color:var(--sg-c,#555)}'
    +'.sg-ms{color:#666;font-size:11.5px;margin-top:1px}';
  function injectCss(){
    if(document.getElementById('sg-css')) return;
    var st=document.createElement('style'); st.id='sg-css'; st.textContent=CSS;
    (document.head||document.documentElement).appendChild(st);
  }
  injectCss();
  w.SchedGroups={MAX:MAX, META:META, num:num, op:op, owner:owner, cols:cols, inGroup:inGroup, used:used,
    activeByDay:activeByDay, activeAt:activeAt, segment:segment, rosters:rosters, groupOfKey:groupOfKey, badge:badge, mirrorHtml:mirrorHtml,
    wrapHtml:wrapHtml, toggle:toggle, setActive:setActive, closeAll:closeAll};
})(window);
