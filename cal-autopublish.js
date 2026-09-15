/* cal-autopublish.js — 予約変更時に公開カレンダーHTML（calendar/YYYYMMcalendar.html /
 * listcal.html）を自動再生成してGitHub（tequiladojo-site）へ反映する自己完結モジュール。
 * admin_data.html の autoPublishCalForMonth と同一のHTML生成・公開ロジックを移植したもので、
 * 同じ localStorage（cal_colors / cal_range / gh_token）を参照するため、同一ブラウザでは
 * admin_data.html の「HTML公開」と同じ出力になる。
 * 使い方: CalAutoPublish.forMonth('YYMMDD').then(function(r){ ... })
 *   r = {ok:true, ym} 公開成功 / {ok:false, reason:'no-token'|'error', message}
 */
(function(){
  var GH_OWNER='teqmae23', GH_REPO='tequiladojo-site', GH_BRANCH='main';
  function ghToken(){ try{ return localStorage.getItem('gh_token')||''; }catch(e){ return ''; } }

  var CAL_BT_LABEL=['夜のみ','昼夜営業','昼のみ','予約営業のみ','定休日','休業日','イベント','貸切','臨時休業'];
  var CAL_BT_DEFAULT_BG=['#E6F1FB','#EAF3DE','#C0DD97','#FAEEDA','#D3D1C7','#B4B2A9','#FBEAF0','#FEF0E0','#D3D1C7'];
  function calLoadColors(){ try{ var s=localStorage.getItem('cal_colors'); if(s) return JSON.parse(s); }catch(e){} return CAL_BT_DEFAULT_BG.slice(); }
  var C23_ICON='data:image/png;base64,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';
  var C23_SRC=C23_ICON;

  function calPad(n){ return String(n).padStart(2,'0'); }
  function calFmtT(h){ if(!h||h.length<4) return ''; return h.slice(0,2)+':'+h.slice(2,4); }
  function calDkey(y,m,d){ return y+'-'+calPad(m+1)+'-'+calPad(d); }
  function calIsC23(m,d){ return d===23||(m===1&&d===3); }
  function calBuildAnnivMap(y,m){
    var map={}; var mthDay=[[1,23],[2,3]];
    mthDay.forEach(function(md){ if(md[0]===m+1){ var key=calDkey(y,m,md[1]); map[key]=map[key]||[]; map[key].push({type:'anniv',name:'テキーラの日'}); }});
    return map;
  }
  var calHolidays={};
  function calFetchHolidays(year){
    return fetch('https://holidays-jp.github.io/api/v1/'+year+'/date.json')
      .then(function(r){ return r.json(); })
      .then(function(data){ calHolidays=data||{}; })
      .catch(function(){ calHolidays={}; });
  }

  var CAL_RANGE={fromY:0,fromM:0,toY:0,toM:0};
  function calInitRange(){
    try{ var s=localStorage.getItem('cal_range'); if(s) CAL_RANGE=JSON.parse(s); }catch(e){}
    var now=new Date();
    if(!CAL_RANGE.fromY){ CAL_RANGE.fromY=now.getFullYear(); CAL_RANGE.fromM=1; }
    if(!CAL_RANGE.toY){ CAL_RANGE.toY=now.getFullYear()+1; CAL_RANGE.toM=12; }
  }

  var CAL_BT_COLORS=calLoadColors();

  // ── HTML生成（admin_data.html と同一） ──────────────────────────
  function genPubGrid(y,m2,schMap,rsvMap,PDOWS,PBT){
    var today=new Date();
    var amap=calBuildAnnivMap(y,m2);
    var first=new Date(y,m2,1).getDay();
    var days=new Date(y,m2+1,0).getDate();
    var prevDays=new Date(y,m2,0).getDate();
    var html='<div class="cal-grid">';
    PDOWS.forEach(function(d,i){html+='<div class="cal-dow'+(i===0?' sun':i===6?' sat':'')+'">' + d+'</div>';});
    var total=(first+days)<=35?35:42;
    for(var i=0;i<total;i++){
      var isOther=i<first||(i>=first+days);
      var day,cy,cm3;
      if(i<first){day=prevDays-(first-1-i);cy=m2===0?y-1:y;cm3=m2===0?11:m2-1;}
      else if(i>=first+days){day=i-first-days+1;cy=m2===11?y+1:y;cm3=m2===11?0:m2+1;}
      else{day=i-first+1;cy=y;cm3=m2;}
      var dow=i%7,key=calDkey(cy,cm3,day);
      var isHol=!!calHolidays[key],anniv=(!isOther)?amap[day]:null;
      var isC23=(!isOther)&&calIsC23(cm3,day);
      var sch=(!isOther)?schMap[day]:null;
      var cls='cal-cell';
      if(isOther)cls+=' cal-other';
      if(dow===0)cls+=' cal-sun';if(dow===6)cls+=' cal-sat';
      if(isHol)cls+=' cal-hol';
      if(sch)cls+=' '+PBT[parseInt(sch.businessType)||0];
      var dayPart=isC23?'<img src="'+C23_SRC+'" style="height:19.8px;width:23.1px;object-fit:fill" alt="23">':'<span class="cal-day-num">'+day+'</span>';
      var namePart=anniv?'<span class="cal-aname">'+(anniv.nameJa||anniv.name||'')+'</span>':(isHol?'<span class="cal-hname">'+calHolidays[key]+'</span>':'<span style="flex:1"></span>');
      var trow='';
      if(sch){
        var bt=parseInt(sch.businessType)||0;
        if(bt===4||bt===5||bt===8){
          trow='<div style="margin-top:2px"><span class="cal-ei">'+(bt===4?'定休日':bt===8?'臨時休業':'休業日')+'</span></div>';
        } else if(sch.openTime&&sch.closeTime){
          var eiLabel=bt===7?'貸切':'営';
          var eiBg=bt===7?'background:rgba(255,140,40,.25);color:#9a5800':'background:#FEF9C3;color:#333';
          trow='<div style="display:flex;align-items:center;gap:3px;margin-top:2px"><span class="cal-ei" style="'+eiBg+'">'+eiLabel+'</span><span class="cal-ttime">'+calFmtT(sch.openTime)+'〜'+calFmtT(sch.closeTime)+'</span></div>';
        } else if(CAL_BT_LABEL[bt]){
          trow='<div style="margin-top:2px"><span class="cal-ei">'+CAL_BT_LABEL[bt]+'</span></div>';
        }
        var memoStr=sch.memo?'<span style="font-size:9px;color:#222;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">'+sch.memo+'</span>':'<span style="flex:1"></span>';
        if(sch.memo){ trow+='<div style="display:flex;align-items:flex-end;margin-top:1px">'+memoStr+'</div>'; }
      }
      var rvs2=(!isOther)?rsvMap[day]:null;
      var rsvRow2='';
      if(rvs2&&rvs2.length){
        var hasC2=rvs2.some(function(r2){return r2.charterType===1||r2.charterType==="1";});
        var sorted2=rvs2.slice().sort(function(a,b){return String(a.startTime||'').localeCompare(String(b.startTime||''));});
        var chips2=sorted2.slice(0,2).map(function(r2){
          return '<span style="font-size:9px;font-weight:600;background:#FBEAF0;color:#C44873;border-radius:2px;padding:0 4px;line-height:1.5;white-space:nowrap">'+calFmtT(r2.startTime)+' '+(r2.guests||'?')+'名</span>';
        });
        if(sorted2.length>2) chips2.push('<span style="font-size:9px;color:#888">他'+(sorted2.length-2)+'件</span>');
        rsvRow2='<div style="display:flex;gap:3px;align-items:center;flex-wrap:wrap;margin-top:2px">'+(hasC2?'<span style="font-size:9px;font-weight:600;background:#7a5610;color:#e8b84a;border-radius:2px;padding:0 4px;line-height:1.5">貸切</span>':'')+chips2.join('')+'</div>';
      }
      html+='<div class="'+cls+'" data-date="'+key+'"><div class="cal-drow">'+dayPart+namePart+'<span class="today-badge" style="font-size:8px;font-weight:600;background:#185FA5;color:#fff;border-radius:2px;padding:0 3px;margin-left:auto;display:none;">当日</span></div>'+trow+rsvRow2+'</div>';
    }
    html+='</div>';
    return html;
  }

  function genPubList(y,m2,schMap,rsvMap,PDOWS,PBT){
    var today=new Date();
    var amap=calBuildAnnivMap(y,m2);
    var days=new Date(y,m2+1,0).getDate();
    var html='<div>';var hasAny=false;
    for(var d=1;d<=days;d++){
      var key=calDkey(y,m2,d);
      var dow=new Date(y,m2,d).getDay();
      var isHol=!!calHolidays[key],anniv=amap[d];
      var isToday=(y===today.getFullYear()&&m2===today.getMonth()&&d===today.getDate());
      var isC23=calIsC23(m2,d);
      var sch=schMap[d];var rvs3=rsvMap[d];
      if(!sch&&!isToday&&!isHol&&!anniv&&!isC23&&(!rvs3||!rvs3.length)) continue;
      hasAny=true;
      var dowCls=dow===0||isHol?'lsun':dow===6?'lsat':'';
      var cls='litem';
      var headCls='lhead '+(sch?PBT[parseInt(sch.businessType)||0]:'');
      var datePart=isC23?'<span class="ldate'+(dowCls?' '+dowCls:'')+'">'+(m2+1).toString().padStart(2,'0')+'/</span><img src="'+C23_SRC+'" style="height:19.8px;width:23.1px;object-fit:fill" alt="23">':'<span class="ldate'+(dowCls?' '+dowCls:'')+'">'+(m2+1).toString().padStart(2,'0')+'/'+d.toString().padStart(2,'0')+'</span>';
      var dowPart='<span class="ldow'+(dowCls?' '+dowCls:'')+'">（'+PDOWS[dow]+'）</span>';
      var timePart='';
      if(sch){
        var bt=parseInt(sch.businessType)||0;
        if(bt===4||bt===5||bt===8){
          timePart='<div class="leitime"><span class="cal-ei">'+(bt===4?'定休日':bt===8?'臨時休業':'休業日')+'</span></div>';
        } else {
          var typeIcon2=(!sch.openTime&&!sch.closeTime&&CAL_BT_LABEL[bt])?'<span class="cal-ei">'+CAL_BT_LABEL[bt]+'</span>':'';
          var eiLabel2=bt===7?'貸切':'営';
          var eiBg2=bt===7?'background:rgba(255,140,40,.25);color:#9a5800':'background:#FEF9C3;color:#333';
          var timeHtml2=sch.openTime&&sch.closeTime?'<span class="cal-ei" style="'+eiBg2+'">'+eiLabel2+'</span><span class="ltime">'+calFmtT(sch.openTime)+'〜'+calFmtT(sch.closeTime)+'</span>':typeIcon2;
          if(timeHtml2) timePart='<div class="leitime">'+timeHtml2+'</div>';
        }
      }
      var names=[];
      if(isHol)names.push('<span style="font-size:11px;color:#E24B4A">'+calHolidays[key]+'</span>');
      if(anniv)names.push('<span style="font-size:11px;color:#993556">'+(anniv.nameJa||anniv.name||'')+'</span>');
      var namesPart=names.length?'<div style="display:flex;flex-direction:column;gap:1px;flex:1;min-width:0;margin-left:4px">'+names.join('')+'</div>':'<span style="flex:1"></span>';
      var todayPart='<span class="today-badge" style="font-size:10px;font-weight:600;background:#185FA5;color:#fff;border-radius:3px;padding:0 5px;margin-left:auto;flex-shrink:0;display:none;">当日</span>';
      var rsvPart3='';
      if(rvs3&&rvs3.length){
        var hasC3=rvs3.some(function(r3){return r3.charterType===1||r3.charterType==="1";});
        var sorted3=rvs3.slice().sort(function(a,b){return String(a.startTime||'').localeCompare(String(b.startTime||''));});
        var chips3=sorted3.map(function(r3){
          return '<span style="font-size:10px;font-weight:600;background:#FBEAF0;color:#C44873;border-radius:3px;padding:0 6px;line-height:1.6;white-space:nowrap">'+calFmtT(r3.startTime)+(r3.endTime?'〜'+calFmtT(r3.endTime):'')+' '+(r3.guests||'?')+'名</span>';
        });
        rsvPart3='<div style="padding:2px 10px 4px;display:flex;gap:4px;flex-wrap:wrap;align-items:center">'+(hasC3?'<span style="font-size:10px;font-weight:600;background:#7a5610;color:#e8b84a;border-radius:3px;padding:0 6px;line-height:1.6">貸切</span>':'')+chips3.join('')+'</div>';
      }
      html+='<div class="'+cls+'" data-date="'+key+'"><div class="'+headCls+'"><div style="display:flex;align-items:center;gap:3px;flex-shrink:0">'+datePart+dowPart+'</div>'+timePart+namesPart+todayPart+'</div>'+(sch&&sch.memo?'<div style="font-size:11px;color:#222;padding:2px 10px 4px">'+sch.memo+'</div>':'')+rsvPart3+'</div>';
    }
    if(!hasAny)html+='<div style="font-size:13px;color:#888;padding:16px">この月の予定はありません</div>';
    html+='</div>';
    return html;
  }

  function genCalPublicHtml(y,m2,schMap,rsvMap,mode){
    var PDOWS=['日','月','火','水','木','金','土'];
    var PBT=['cbt0','cbt1','cbt2','cbt3','cbt4','cbt5','cbt6','cbt7','cbt8'];
    var ym=String(y)+String(m2+1).padStart(2,'0');
    var pm=m2-1<0?11:m2-1,py=m2-1<0?y-1:y;
    var nm=m2+1>11?0:m2+1,ny=m2+1>11?y+1:y;
    var prevYm=String(py)+String(pm+1).padStart(2,'0');
    var nextYm=String(ny)+String(nm+1).padStart(2,'0');
    var suffix=mode==='cal'?'calendar':'listcal';
    calInitRange();
    var fromVal=CAL_RANGE.fromY*12+CAL_RANGE.fromM;
    var toVal=CAL_RANGE.toY*12+CAL_RANGE.toM;
    var prevVal=py*12+(pm+1);
    var nextVal=ny*12+(nm+1);
    var hasPrev=prevVal>=fromVal;
    var hasNext=nextVal<=toVal;
    var opts='';
    for(var i2=-36;i2<=36;i2++){var tm2x=m2+i2,ty2=y;while(tm2x<0){tm2x+=12;ty2--;}while(tm2x>11){tm2x-=12;ty2++;}var tYm2=String(ty2)+String(tm2x+1).padStart(2,'0');var tVal2=ty2*12+(tm2x+1);if(tVal2<fromVal||tVal2>toVal)continue;opts+='<option value="'+tYm2+'"'+(tYm2===ym?' selected':'')+'>'+ty2+'年'+(tm2x+1)+'月</option>';}
    var BASE='https://www.tequiladojo.com/calendar/';
    var prevBtn=hasPrev?'<a href="'+BASE+prevYm+suffix+'.html" style="text-decoration:none;padding:4px 12px;border:1px solid #ddd;border-radius:6px;color:#333">&#8592;</a>':'<span style="padding:4px 12px;border:1px solid #eee;border-radius:6px;color:#ccc;cursor:default">&#8592;</span>';
    var nextBtn=hasNext?'<a href="'+BASE+nextYm+suffix+'.html" style="text-decoration:none;padding:4px 12px;border:1px solid #ddd;border-radius:6px;color:#333">&#8594;</a>':'<span style="padding:4px 12px;border:1px solid #eee;border-radius:6px;color:#ccc;cursor:default">&#8594;</span>';
    var nav='<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap">'+prevBtn+'<span style="font-size:20px;font-weight:500">'+y+'年'+(m2+1)+'月</span>'+nextBtn+(opts?'<select onchange="location.href=\''+BASE+'\'+(this.value)+\''+suffix+'.html\'" style="padding:4px 8px;border:1px solid #ddd;border-radius:6px;font-size:13px">'+opts+'</select>':'')+'<div style="margin-left:auto;display:flex;gap:6px;align-items:center"><a href="https://www.tequiladojo.com/" style="text-decoration:none;padding:4px 12px;border:1px solid #ddd;border-radius:6px;font-size:12px;color:#333">TOPへ</a><a href="'+BASE+ym+'calendar.html" style="text-decoration:none;padding:4px 12px;border:1px solid #ddd;border-radius:6px;font-size:12px;color:#333'+(mode==='cal'?';background:#333;color:#fff':'')+'">カレンダー</a><a href="'+BASE+ym+'listcal.html" style="text-decoration:none;padding:4px 12px;border:1px solid #ddd;border-radius:6px;font-size:12px;color:#333'+(mode==='list'?';background:#333;color:#fff':'')+'">リスト</a></div></div>';
    var body=mode==='cal'?genPubGrid(y,m2,schMap,rsvMap,PDOWS,PBT):genPubList(y,m2,schMap,rsvMap,PDOWS,PBT);
    var legend='<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:16px">'+CAL_BT_LABEL.map(function(lbl,i){var c=CAL_BT_COLORS[i]||CAL_BT_DEFAULT_BG[i];return '<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:#666"><div style="width:10px;height:10px;border-radius:2px;background:'+c+';border:0.5px solid rgba(0,0,0,0.15)"></div>'+lbl+'</div>';}).join('')+'</div>';
    var css='<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:sans-serif;background:#f9f7f2;color:#333}.cal-grid{display:grid;grid-template-columns:repeat(7,minmax(56px,1fr));gap:4px}.cal-dow{text-align:center;font-size:11px;font-weight:500;padding:4px 0;color:#888}.cal-dow.sun{color:#E24B4A}.cal-dow.sat{color:#378ADD}.cal-cell{min-height:90px;border:0.5px solid #ddd;border-radius:6px;padding:4px 5px;overflow:hidden;background:#fff}.cal-cell.cal-other{opacity:0.3}.cal-cell.cal-today{border:2px solid #185FA5}'+(function(){var s='';CAL_BT_COLORS.forEach(function(c,i){s+='.cbt'+i+'{background:'+c+'}'});return s;}())+'.cal-day-num{font-size:20px;font-weight:500;line-height:1;flex-shrink:0}.cal-drow{display:flex;align-items:center;gap:3px;margin-bottom:2px;min-height:26px}.cal-hname{font-size:9px;color:#E24B4A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}.cal-aname{font-size:9px;color:#993556;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}.cal-ei{font-size:11px;font-weight:600;background:#444;color:#fff;border-radius:3px;padding:1px 5px;line-height:1.6}.cal-ttime{font-size:10px;color:#666;font-family:monospace}.litem{border:0.5px solid #ddd;border-radius:6px;overflow:hidden;margin-bottom:6px}.litem.ltoday{border:3px solid #185FA5}.lhead{display:flex;align-items:center;gap:6px;padding:6px 10px}.ldate{font-size:20px;font-weight:500;line-height:1}.ldate.lsun,.ldate.lhol{color:#E24B4A}.ldate.lsat{color:#378ADD}.ldow{font-size:13px;font-weight:500;color:#333}.ldow.lsun,.ldow.lhol{color:#E24B4A}.ldow.lsat{color:#378ADD}.leitime{display:flex;align-items:center;gap:4px;flex-shrink:0}.ltime{font-size:14px;font-weight:500;font-family:monospace}@media(max-width:480px){.cal-cell{min-height:70px}.cal-day-num{font-size:16px}}</style>';
    return '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>テキーラ道場 営業カレンダー '+y+'年'+(m2+1)+'月</title>'+css+'</head><body><div style="max-width:900px;margin:0 auto;padding:16px"><div style="text-align:center;margin-bottom:16px"><h1 style="font-size:18px;font-weight:500;color:#333">🌵 テキーラ道場 営業カレンダー</h1></div>'+nav+body+legend+'</div><script>(function(){var t=new Date();var today=t.getFullYear()+"-"+(t.getMonth()+1).toString().padStart(2,"0")+"-"+t.getDate().toString().padStart(2,"0");document.querySelectorAll("[data-date]").forEach(function(el){var isToday=el.dataset.date===today;var badge=el.querySelector(".today-badge");var litem=el.closest(".litem");if(isToday){el.classList.add("cal-today");if(badge)badge.style.display="inline";if(litem)litem.classList.add("ltoday");}else{el.classList.remove("cal-today");if(badge)badge.style.display="none";if(litem)litem.classList.remove("ltoday");}});})();<\/script></body></html>';
  }

  // ── GitHub 直接コミット（admin_data.html と同一・localStorage の gh_token を使用） ──
  function toBase64(str){ var bytes=new TextEncoder().encode(str); var binary=''; bytes.forEach(function(b){binary+=String.fromCharCode(b);}); return btoa(binary); }
  function ghPutFile(path,content){
    var token=ghToken();
    var url='https://api.github.com/repos/'+GH_OWNER+'/'+GH_REPO+'/contents/'+path;
    var headers={'Authorization':'token '+token,'Content-Type':'application/json','Accept':'application/vnd.github.v3+json'};
    return fetch(url,{headers:headers}).then(function(r){return r.ok?r.json():null;}).then(function(existing){
      var body={message:'Update '+path,content:toBase64(content),branch:GH_BRANCH};
      if(existing&&existing.sha) body.sha=existing.sha;
      return fetch(url,{method:'PUT',headers:headers,body:JSON.stringify(body)});
    }).then(function(r){ if(!r.ok) return r.text().then(function(t){throw new Error('GitHub API error ('+path+'): '+r.status+' '+t.slice(0,200));}); return r.json(); });
  }
  function deployToGitHub(files){
    var chain=Promise.resolve();
    files.forEach(function(f){ chain=chain.then(function(){ return ghPutFile(f.path,f.content); }); });
    return chain;
  }

  // ── 公開カレンダーHTMLの自動再生成＋反映 ──────────────────────
  // yymmdd: 予約日（YYMMDD）。該当月の calendar/list を再生成して公開する。
  function forMonth(yymmdd){
    yymmdd=String(yymmdd||'');
    if(yymmdd.length<4) return Promise.resolve({ok:false, reason:'bad-date'});
    var ym4='20'+yymmdd.slice(0,2)+yymmdd.slice(2,4);
    var y4=parseInt(ym4.slice(0,4),10), m4=parseInt(ym4.slice(4,6),10)-1;
    var db;
    try{ db=firebase.firestore(); }catch(e){ return Promise.resolve({ok:false, reason:'no-firestore'}); }
    // 更新時刻は常に記録（未公開インジケータ用）
    var nowIso=new Date().toISOString();
    db.collection('calMeta').doc(ym4).set({updatedAt:nowIso},{merge:true}).catch(function(){});
    try{ localStorage.setItem('cal_updated_'+ym4, nowIso); }catch(e){}
    if(!ghToken()) return Promise.resolve({ok:false, reason:'no-token'});
    CAL_BT_COLORS=calLoadColors(); // 最新の配色を反映
    var schMap={},rsvMap={};
    var p1=db.collection('schedules').get().then(function(snap){
      snap.docs.forEach(function(doc){ var sid=doc.data().scheduleId||doc.id; if(String(sid).slice(0,6)===ym4){var dy=parseInt(String(sid).slice(6,8),10);schMap[dy]=doc.data();} });
    }).catch(function(){});
    var p2=db.collection('reservations').get().then(function(snap){
      snap.docs.forEach(function(doc){ var rd=doc.data().reservationDate||''; if(('20'+rd).slice(0,6)===ym4){var dy=parseInt(rd.slice(4,6),10);if(!rsvMap[dy])rsvMap[dy]=[];rsvMap[dy].push(doc.data());} });
    }).catch(function(){});
    return Promise.all([p1,p2]).then(function(){ return calFetchHolidays(y4); }).then(function(){
      var calHtml=genCalPublicHtml(y4,m4,schMap,rsvMap,'cal');
      var listHtml=genCalPublicHtml(y4,m4,schMap,rsvMap,'list');
      return deployToGitHub([
        {path:'calendar/'+ym4+'calendar.html',content:calHtml},
        {path:'calendar/'+ym4+'listcal.html',content:listHtml}
      ]);
    }).then(function(){
      var iso=new Date().toISOString();
      db.collection('calMeta').doc(ym4).set({publishedAt:iso},{merge:true}).catch(function(){});
      try{ localStorage.setItem('cal_published_'+ym4, iso); }catch(e){}
      return {ok:true, ym:ym4};
    }).catch(function(e){ return {ok:false, reason:'error', message:(e&&e.message)||String(e)}; });
  }

  window.CalAutoPublish={ forMonth: forMonth };
})();
