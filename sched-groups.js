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
  function wrapHtml(colsHtml, active, opts){
    opts=opts||{};
    var sides=[2,3].filter(function(g){ return active&&active[g]; });
    if(!sides.length) return colsHtml[1]||'';
    var ph=function(g){ return opts.paneHead?(opts.paneHead(g)||''):''; };
    var h='<div class="sg-wrap"><div class="sg-col sg-main"><div class="sg-main-hd"><span>'+META[1].name+'</span>'+ph(1)+'</div>'
      +(colsHtml[1]||'<div class="sg-empty">'+META[1].name+'の予定なし</div>')+'</div>';
    sides.forEach(function(g){
      var m=META[g];
      h+='<div class="sg-side" data-g="'+g+'" style="--sg-c:'+m.color+';--sg-bg:'+m.bg+'">'
        +'<button type="button" class="sg-bar" title="'+m.name+'のスケジュールを開閉" onclick="event.stopPropagation();SchedGroups.toggle('+g+')"><span>'+m.name+'</span></button>'
        +'<div class="sg-pane"><div class="sg-pane-hd"><span>'+m.name+'</span>'+ph(g)+'</div>'
        +(colsHtml[g]||'<div class="sg-empty">この日の'+m.name+'の予定なし</div>')+'</div></div>';
    });
    return h+'</div>';
  }
  function _syncAny(){
    var b=document.body;
    b.classList.toggle('sg-any-open', b.classList.contains('sg-open-2')||b.classList.contains('sg-open-3'));
  }
  // 展開状態は全日共通（再描画しても body のクラスで維持）
  function toggle(g){
    var b=document.body, cls='sg-open-'+g, on=!b.classList.contains(cls);
    b.classList.toggle(cls,on); _syncAny();
    if(on) setTimeout(function(){
      Array.prototype.forEach.call(document.querySelectorAll('.sg-side[data-g="'+g+'"]'),function(s){
        var wr=s.parentNode; if(wr && wr.scrollWidth>wr.clientWidth) wr.scrollLeft=s.offsetLeft;
      });
    },30);
  }
  function closeAll(){ var b=document.body; b.classList.remove('sg-open-2','sg-open-3','sg-any-open'); }
  var CSS=''
    +'.sg-wrap{display:flex;align-items:stretch;gap:6px;position:relative;overflow-x:auto;-webkit-overflow-scrolling:touch}'
    +'.sg-col.sg-main{flex:1 1 0;min-width:0}'
    +'.sg-side{display:flex;align-items:stretch;flex:0 0 auto}'
    +'.sg-bar{flex:0 0 14px;width:14px;min-height:44px;border:none;border-radius:7px;background:var(--sg-c);opacity:.5;cursor:pointer;padding:0;display:flex;align-items:flex-start;justify-content:center;font-family:inherit}'
    +'.sg-bar:hover{opacity:.85}'
    +'.sg-bar span{writing-mode:vertical-rl;text-orientation:upright;color:#fff;font-size:10px;font-weight:700;letter-spacing:.12em;padding:8px 0;line-height:14px}'
    +'.sg-pane{display:none}'
    +'.sg-main-hd,.sg-pane-hd{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;margin-bottom:6px}'
    +'.sg-main-hd{display:none;color:#7a5610}'
    +'.sg-main-hd>span,.sg-pane-hd>span{flex:1}'
    +'.sg-pane-hd{color:var(--sg-c)}'
    +'body.sg-any-open .sg-main-hd{display:flex}'
    +'body.sg-any-open .sg-col.sg-main{min-width:240px}'
    +'body.sg-open-2 .sg-side[data-g="2"],body.sg-open-3 .sg-side[data-g="3"]{flex:1 1 0;min-width:240px}'
    +'body.sg-open-2 .sg-side[data-g="2"] .sg-bar,body.sg-open-3 .sg-side[data-g="3"] .sg-bar{opacity:1}'
    +'body.sg-open-2 .sg-side[data-g="2"] .sg-pane,body.sg-open-3 .sg-side[data-g="3"] .sg-pane{display:block;flex:1 1 auto;min-width:0;margin-left:6px;padding:6px;border-radius:10px;background:var(--sg-bg);border:1px solid var(--sg-c)}'
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
    activeByDay:activeByDay, rosters:rosters, groupOfKey:groupOfKey, badge:badge, mirrorHtml:mirrorHtml,
    wrapHtml:wrapHtml, toggle:toggle, closeAll:closeAll};
})(window);
