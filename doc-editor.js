/* doc-editor.js — 共通文書エディタ部品（ニュース／書庫などで再利用）
 *
 * 使い方:
 *   const ed = DocEditor.mount(hostEl, { value:'<p>...</p>', onChange:fn });
 *   ed.getHTML();                       // 現在の本文HTML
 *   ed.setHTML(html);                   // 本文を差し替え
 *   await ed.uploadInlineImages(storage, 'news');  // data:画像をStorageへ上げ src差し替え（保存前に呼ぶ）
 *
 * 特長: 画像を選択→角ハンドルでリサイズ／ドラッグで移動／配置切替（左回り込み・中央・右回り込み・行内）。
 *       本文欄は公開記事と同じ明るいキャンバス（WYSIWYG＝見えたまま公開）。
 */
(function(){
  'use strict';
  var STYLE_ID='doc-editor-style';
  function injectCSS(){
    if(document.getElementById(STYLE_ID)) return;
    var css=''
      +'.de-root{position:relative}'
      +'.de-toolbar{display:flex;flex-wrap:wrap;gap:3px;padding:6px 8px;background:#2a2a2a;border:1px solid #444;border-bottom:none;border-radius:6px 6px 0 0}'
      +'.de-tb{padding:3px 8px;font-size:12px;border:1px solid #555;background:#333;color:#ddd;border-radius:3px;cursor:pointer;line-height:1.4;font-family:inherit}'
      +'.de-tb:hover{background:#444;color:#fff}.de-tb:active{background:#555}'
      +'.de-sep{width:1px;background:#444;margin:2px 4px;align-self:stretch}'
      +'.de-tb-lbl{display:flex;align-items:center;gap:3px;cursor:pointer}'
      +'.de-wrap{border:1px solid #444;border-top:none;border-radius:0 0 6px 6px;background:#e9e6df;max-height:60vh;overflow:auto;padding:14px 10px}'
      // 公開記事(.news-modal-body)に合わせたWYSIWYGキャンバス
      +'.de-canvas{background:#fff;color:#2a2a2a;max-width:520px;margin:0 auto;min-height:220px;padding:18px 20px;border-radius:6px;'
        +'box-shadow:0 2px 10px rgba(0,0,0,.18);font-size:14px;line-height:1.75;outline:none;word-break:break-word}'
      +'.de-canvas:empty:before{content:attr(data-ph);color:#9aa;}'
      +'.de-canvas h3{font-size:15px;font-weight:700;margin:.8em 0 .3em}'
      +'.de-canvas h4{font-size:14px;font-weight:700;margin:.6em 0 .25em}'
      +'.de-canvas p{margin:.5em 0}.de-canvas ul,.de-canvas ol{padding-left:1.4em;margin:.4em 0}'
      +'.de-canvas a{color:#1a6ec0;text-decoration:underline}'
      +'.de-canvas hr{border:none;border-top:1px solid #ccc;margin:.8em 0}'
      +'.de-canvas img{max-width:100%;height:auto;border-radius:4px}'
      +'.de-canvas img.de-sel{outline:2px solid #1a9e6a;outline-offset:1px}'
      +'.de-src{display:none;width:100%;min-height:220px;max-height:60vh;padding:12px 14px;background:#0d0d0d;border:1px solid #444;border-top:none;'
        +'border-radius:0 0 6px 6px;color:#4ec9b0;font-family:"Fira Code","Consolas",monospace;font-size:12px;line-height:1.6;resize:vertical;box-sizing:border-box}'
      // 画像選択時の浮動バー・リサイズハンドル
      +'.de-imgbar{position:absolute;z-index:30;display:none;gap:4px;background:#1f1f1f;border:1px solid #555;border-radius:7px;padding:4px 6px;box-shadow:0 3px 12px rgba(0,0,0,.35)}'
      +'.de-imgbar.show{display:flex}'
      +'.de-ib{border:1px solid #555;background:#333;color:#ddd;border-radius:4px;font-size:12px;padding:3px 7px;cursor:pointer;font-family:inherit;line-height:1.3}'
      +'.de-ib:hover{background:#444;color:#fff}.de-ib.on{background:#1a9e6a;border-color:#1a9e6a;color:#fff}'
      +'.de-ib.del{color:#ffb4a8;border-color:#7a3a2c}'
      +'.de-rh{position:absolute;z-index:29;width:13px;height:13px;background:#fff;border:2px solid #1a9e6a;border-radius:50%;display:none;box-sizing:border-box}'
      +'.de-rh.show{display:block}'
      +'.de-rh.nw{cursor:nwse-resize}.de-rh.ne{cursor:nesw-resize}.de-rh.sw{cursor:nesw-resize}.de-rh.se{cursor:nwse-resize}'
      +'.de-imgdlg{background:#1a1a1a;border:1px solid #555;border-radius:6px;padding:12px;margin-top:6px;display:none}'
      +'.de-imgdlg.show{display:block}'
      +'.de-imgdlg .fi{width:100%;box-sizing:border-box;font-size:12px;padding:6px 8px;background:#111;border:1px solid #555;color:#ddd;border-radius:4px;margin-bottom:8px}'
      +'.de-hint{font-size:11px;color:#8a8a8a;padding:6px 2px 0}'
      // 画像の拡大表示（ライトボックス・共通）
      +'.de-lb{position:fixed;inset:0;z-index:4000;background:rgba(0,0,0,.86);display:none;align-items:center;justify-content:center;padding:20px}'
      +'.de-lb.show{display:flex}'
      +'.de-lb img{max-width:94vw;max-height:90vh;border-radius:4px;object-fit:contain}'
      +'.de-lb-x{position:absolute;top:14px;right:16px;width:38px;height:38px;border-radius:50%;border:none;background:rgba(255,255,255,.15);color:#fff;font-size:18px;cursor:pointer}';
    var s=document.createElement('style'); s.id=STYLE_ID; s.textContent=css; document.head.appendChild(s);
  }

  function el(tag, cls, html){ var e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; }

  // ── 画像の拡大表示（共通ライトボックス。エディタ・プレビュー・書庫などで再利用） ──
  var _lb=null;
  function closeLightbox(){ if(_lb){ _lb.classList.remove('show'); var im=_lb.querySelector('img'); if(im) im.removeAttribute('src'); } }
  function openImage(src){
    if(!src) return;
    if(!_lb){
      injectCSS();
      _lb=document.createElement('div'); _lb.className='de-lb';
      _lb.innerHTML='<button type="button" class="de-lb-x" aria-label="閉じる">✕</button><img alt="">';
      _lb.addEventListener('click',function(e){ if(e.target===_lb || (e.target.className||'').indexOf('de-lb-x')>=0) closeLightbox(); });
      document.addEventListener('keydown',function(e){ if(e.key==='Escape') closeLightbox(); });
      document.body.appendChild(_lb);
    }
    _lb.querySelector('img').src=src; _lb.classList.add('show');
  }

  function mount(host, opts){
    opts=opts||{};
    injectCSS();
    host.classList.add('de-root');
    host.innerHTML='';
    var placeholder=opts.placeholder||'本文を入力…';

    // ツールバー
    var tb=el('div','de-toolbar');
    tb.innerHTML=''
      +'<button type="button" class="de-tb" data-cmd="bold" title="太字"><b>B</b></button>'
      +'<button type="button" class="de-tb" data-cmd="italic" title="斜体"><i>I</i></button>'
      +'<button type="button" class="de-tb" data-cmd="underline" title="下線"><u>U</u></button>'
      +'<span class="de-sep"></span>'
      +'<button type="button" class="de-tb" data-ins="h3" title="見出し">H3</button>'
      +'<button type="button" class="de-tb" data-ins="h4" title="小見出し">H4</button>'
      +'<button type="button" class="de-tb" data-ins="ul" title="箇条書き">UL</button>'
      +'<button type="button" class="de-tb" data-ins="ol" title="番号リスト">OL</button>'
      +'<button type="button" class="de-tb" data-ins="hr" title="区切り線">HR</button>'
      +'<span class="de-sep"></span>'
      +'<label class="de-tb de-tb-lbl" title="文字色"><span style="font-size:11px">A</span>'
        +'<input type="color" class="de-color" value="#e8961e" style="width:18px;height:14px;border:none;padding:0;background:none;cursor:pointer"></label>'
      +'<button type="button" class="de-tb" data-link="1" title="リンク">🔗</button>'
      +'<button type="button" class="de-tb" data-img="1" title="画像を追加">🖼 画像</button>'
      +'<span class="de-sep"></span>'
      +'<button type="button" class="de-tb" data-cmd="removeFormat" title="書式クリア" style="font-size:10px">✕書式</button>'
      +'<span style="flex:1"></span>'
      +'<button type="button" class="de-tb de-srcbtn" title="HTMLソース切替">&lt;/&gt;</button>';

    var wrap=el('div','de-wrap');
    var canvas=el('div','de-canvas'); canvas.contentEditable='true'; canvas.setAttribute('data-ph',placeholder);
    wrap.appendChild(canvas);
    var src=el('textarea','de-src'); src.placeholder='HTMLソースを直接編集…';
    var fileInput=el('input'); fileInput.type='file'; fileInput.accept='image/*'; fileInput.style.display='none';
    var imgbar=el('div','de-imgbar');
    imgbar.innerHTML=''
      +'<button type="button" class="de-ib" data-al="inline" title="行内">行内</button>'
      +'<button type="button" class="de-ib" data-al="left" title="左寄せ（回り込み）">◧左</button>'
      +'<button type="button" class="de-ib" data-al="center" title="中央">▣中央</button>'
      +'<button type="button" class="de-ib" data-al="right" title="右寄せ（回り込み）">右◨</button>'
      +'<button type="button" class="de-ib" data-zoom="1" title="拡大表示">🔍</button>'
      +'<button type="button" class="de-ib del" data-del="1" title="画像を削除">🗑</button>';
    var handles={};
    ['nw','ne','sw','se'].forEach(function(k){ var h=el('div','de-rh '+k); h.dataset.h=k; handles[k]=h; });
    var hint=el('div','de-hint','画像はクリックで選択 → 角をドラッグでサイズ変更・画像をドラッグで移動・配置ボタンで回り込み。');

    host.appendChild(tb); host.appendChild(wrap); host.appendChild(src); host.appendChild(fileInput);
    host.appendChild(imgbar); Object.keys(handles).forEach(function(k){ host.appendChild(handles[k]); });
    host.appendChild(hint);

    var srcMode=false, selImg=null, rafId=0;
    function emitChange(){ if(typeof opts.onChange==='function'){ try{ opts.onChange(getHTML()); }catch(e){} } }

    // ── 画像の配置（公開側でもそのまま再現される inline style） ──
    function applyAlign(img, align){
      img.style.float=''; img.style.display=''; img.style.margin=''; img.style.verticalAlign='';
      img.setAttribute('data-align',align);
      if(align==='center'){ img.style.display='block'; img.style.margin='0.4em auto'; }
      else if(align==='left'){ img.style.float='left'; img.style.margin='0.2em 12px 8px 0'; }
      else if(align==='right'){ img.style.float='right'; img.style.margin='0.2em 0 8px 12px'; }
      else { img.style.display='inline'; img.style.verticalAlign='middle'; }
      if(!img.style.maxWidth) img.style.maxWidth='100%';
    }
    function curAlign(img){ return img.getAttribute('data-align')||(img.style.cssFloat==='left'||img.style.float==='left'?'left':(img.style.float==='right'?'right':(img.style.display==='block'?'center':'inline'))); }

    function positionOverlay(){
      rafId=0;
      if(!selImg||srcMode||!host.contains(selImg)){ hideOverlay(); return; }
      var cr=host.getBoundingClientRect(), ir=selImg.getBoundingClientRect();
      var wr=wrap.getBoundingClientRect();
      // キャンバスの可視領域にかかっていなければ隠す
      if(ir.bottom<wr.top||ir.top>wr.bottom){ imgbar.classList.remove('show'); Object.keys(handles).forEach(function(k){handles[k].classList.remove('show');}); return; }
      var x=ir.left-cr.left, y=ir.top-cr.top;
      function setH(k,hx,hy){ var h=handles[k]; h.classList.add('show'); h.style.left=(hx-6.5)+'px'; h.style.top=(hy-6.5)+'px'; }
      setH('nw',x,y); setH('ne',x+ir.width,y); setH('sw',x,y+ir.height); setH('se',x+ir.width,y+ir.height);
      imgbar.classList.add('show');
      var bx=Math.max(0,Math.min(x, cr.width-200)), by=y-40; if(by<0) by=y+ir.height+6;
      imgbar.style.left=bx+'px'; imgbar.style.top=by+'px';
    }
    function schedulePos(){ if(!rafId) rafId=requestAnimationFrame(positionOverlay); }
    function hideOverlay(){ imgbar.classList.remove('show'); Object.keys(handles).forEach(function(k){handles[k].classList.remove('show');}); }
    function selectImg(img){
      if(selImg) selImg.classList.remove('de-sel');
      selImg=img||null;
      if(selImg){ selImg.classList.add('de-sel'); selImg.setAttribute('draggable','true'); schedulePos(); }
      else hideOverlay();
    }

    // ── リサイズ（角ハンドル） ──
    function startResize(ev, k){
      if(!selImg) return; ev.preventDefault();
      var startX=(ev.touches?ev.touches[0].clientX:ev.clientX);
      var startW=selImg.getBoundingClientRect().width;
      var canvasW=canvas.clientWidth-40; // パディング分を除いた最大
      var left=(k==='nw'||k==='sw');
      function move(e){
        var cx=(e.touches?e.touches[0].clientX:e.clientX);
        var dx=cx-startX; var w=left?(startW-dx):(startW+dx);
        w=Math.max(40,Math.min(w,canvasW));
        selImg.style.width=Math.round(w)+'px'; selImg.style.height='';
        schedulePos();
      }
      function up(){ document.removeEventListener('mousemove',move); document.removeEventListener('mouseup',up);
        document.removeEventListener('touchmove',move); document.removeEventListener('touchend',up); emitChange(); }
      document.addEventListener('mousemove',move); document.addEventListener('mouseup',up);
      document.addEventListener('touchmove',move,{passive:false}); document.addEventListener('touchend',up);
    }
    Object.keys(handles).forEach(function(k){
      handles[k].addEventListener('mousedown',function(e){ startResize(e,k); });
      handles[k].addEventListener('touchstart',function(e){ startResize(e,k); },{passive:false});
    });

    // ── 画像バー操作 ──
    imgbar.addEventListener('mousedown',function(e){ e.preventDefault(); }); // 選択を維持
    imgbar.addEventListener('click',function(e){
      var b=e.target.closest('button'); if(!b||!selImg) return;
      if(b.dataset.del){ var p=selImg; selectImg(null); p.remove(); emitChange(); return; }
      if(b.dataset.zoom){ openImage(selImg.currentSrc||selImg.src); return; }
      if(b.dataset.al){ applyAlign(selImg,b.dataset.al); schedulePos(); emitChange(); }
    });

    // ── キャンバス操作 ──
    canvas.addEventListener('click',function(e){ if(e.target&&e.target.tagName==='IMG'){ selectImg(e.target); } else { selectImg(null); } });
    canvas.addEventListener('input',function(){ if(selImg&&!canvas.contains(selImg)) selectImg(null); else schedulePos(); emitChange(); });
    canvas.addEventListener('scroll',schedulePos); wrap.addEventListener('scroll',schedulePos);
    canvas.addEventListener('dragend',function(){ schedulePos(); emitChange(); });
    window.addEventListener('resize',schedulePos);
    document.addEventListener('scroll',schedulePos,true); // 祖先（モーダル本文）のスクロールにも追従
    canvas.addEventListener('keydown',function(e){ if((e.key==='Delete'||e.key==='Backspace')&&selImg){ var p=selImg; selectImg(null); p.remove(); e.preventDefault(); emitChange(); } });

    // ── ツールバー ──
    function focusCanvas(){ canvas.focus(); }
    function exec(cmd){ focusCanvas(); document.execCommand(cmd,false,null); emitChange(); }
    function insertHTML(html){ focusCanvas(); document.execCommand('insertHTML',false,html); emitChange(); }
    tb.addEventListener('click',function(e){
      var b=e.target.closest('button'); if(!b) return;
      if(b.dataset.cmd){ exec(b.dataset.cmd); return; }
      if(b.classList.contains('de-srcbtn')){ toggleSrc(); return; }
      if(b.dataset.link){
        var url=prompt('URLを入力してください','https://'); if(!url) return;
        var text=prompt('リンクテキスト',''); if(text==null) return; if(!text) text=url;
        insertHTML('<a href="'+url.replace(/"/g,'&quot;')+'" target="_blank" rel="noopener">'+escHtml(text)+'</a>'); return;
      }
      if(b.dataset.img){ fileInput.value=''; fileInput.click(); return; }
      if(b.dataset.ins){
        var t=b.dataset.ins, html='';
        if(t==='h3') html='<h3>見出し</h3>';
        else if(t==='h4') html='<h4>小見出し</h4>';
        else if(t==='ul') html='<ul><li>項目</li></ul>';
        else if(t==='ol') html='<ol><li>項目</li></ol>';
        else if(t==='hr') html='<hr>';
        insertHTML(html); return;
      }
    });
    tb.querySelector('.de-color').addEventListener('input',function(){ focusCanvas(); document.execCommand('foreColor',false,this.value); emitChange(); });

    // ── 画像の挿入（端末内で圧縮→data:挿入。保存時にStorageへ） ──
    function insertImageFile(f){
      if(!f) return;
      var url=URL.createObjectURL(f), img=new Image();
      img.onload=function(){
        var MAX=opts.maxImageDim||1400;
        var w=img.naturalWidth||img.width, h=img.naturalHeight||img.height;
        var sc=Math.min(1,MAX/w,MAX/h), tw=Math.max(1,Math.round(w*sc)), th=Math.max(1,Math.round(h*sc));
        var cv=document.createElement('canvas'); cv.width=tw; cv.height=th; cv.getContext('2d').drawImage(img,0,0,tw,th);
        var data=cv.toDataURL('image/jpeg',0.82); URL.revokeObjectURL(url);
        // 既定: 中央・本文幅にフィット（大きすぎる画像は縮小表示）
        var dispW=Math.min(tw, canvas.clientWidth-40);
        var node=document.createElement('img'); node.src=data; node.style.width=Math.round(dispW)+'px'; node.style.maxWidth='100%'; node.style.height='auto';
        applyAlign(node,'center');
        focusCanvas();
        var sel=window.getSelection();
        if(sel&&sel.rangeCount&&canvas.contains(sel.anchorNode)){ var r=sel.getRangeAt(0); r.collapse(false); r.insertNode(node); r.setStartAfter(node); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
        else { canvas.appendChild(node); }
        selectImg(node); emitChange();
      };
      img.onerror=function(){ URL.revokeObjectURL(url); alert('画像の読み込みに失敗しました'); };
      img.src=url;
    }
    fileInput.addEventListener('change',function(){ var f=this.files&&this.files[0]; this.value=''; insertImageFile(f); });
    // 画像の貼り付け（クリップボードの画像を圧縮して挿入）
    canvas.addEventListener('paste',function(e){
      var items=((e.clipboardData||window.clipboardData)||{}).items||[];
      for(var i=0;i<items.length;i++){ if(items[i].type&&items[i].type.indexOf('image')===0){ e.preventDefault(); insertImageFile(items[i].getAsFile()); return; } }
    });

    // ── ソース切替 ──
    function toggleSrc(){
      srcMode=!srcMode;
      if(srcMode){ src.value=canvas.innerHTML; canvas.style.display='none'; wrap.style.display='none'; src.style.display='block'; selectImg(null); tb.querySelector('.de-srcbtn').style.background='#1a9e6a'; }
      else { canvas.innerHTML=src.value; wrap.style.display=''; canvas.style.display=''; src.style.display='none'; tb.querySelector('.de-srcbtn').style.background=''; prepImages(); emitChange(); }
    }

    // 既存HTML内の画像に data-align / draggable を付与
    function prepImages(){ canvas.querySelectorAll('img').forEach(function(im){ im.setAttribute('draggable','true'); if(!im.getAttribute('data-align')) im.setAttribute('data-align',curAlign(im)); }); }

    function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    // ── 公開API ──
    function getHTML(){ return srcMode?src.value:canvas.innerHTML; }
    function setHTML(html){ srcMode=false; canvas.style.display=''; wrap.style.display=''; src.style.display='none'; tb.querySelector('.de-srcbtn').style.background=''; canvas.innerHTML=html||''; prepImages(); selectImg(null); }
    function focus(){ focusCanvas(); }
    // data:画像をFirebase Storageへアップロードし src を差し替えたHTMLを返す（保存前に呼ぶ）
    function uploadInlineImages(storage, prefix){
      var html=getHTML();
      if(!storage) return Promise.resolve(html);
      var re=/<img([^>]*?)src="(data:image\/[^;]+;base64,[^"]+)"([^>]*?)>/gi, matches=[], m;
      while((m=re.exec(html))!==null){ matches.push({full:m[0],pre:m[1],data:m[2],post:m[3]}); }
      if(!matches.length) return Promise.resolve(html);
      var i=0;
      function next(){
        if(i>=matches.length){ if(srcMode) src.value=html; else { canvas.innerHTML=html; prepImages(); } return html; }
        var mt=matches[i], mime=(mt.data.match(/^data:(image\/[^;]+);base64,/)||[])[1]||'image/jpeg';
        var ext=mime==='image/png'?'png':(mime==='image/webp'?'webp':'jpg');
        var b64=mt.data.replace(/^data:image\/[^;]+;base64,/,''), bin=atob(b64), arr=new Uint8Array(bin.length);
        for(var j=0;j<bin.length;j++) arr[j]=bin.charCodeAt(j);
        var blob=new Blob([arr],{type:mime});
        var path=(prefix||'docs')+'/'+Date.now()+'_'+i+'.'+ext, ref=storage.ref().child(path);
        return ref.put(blob,{contentType:mime}).then(function(snap){ return snap.ref.getDownloadURL(); }).then(function(dl){
          html=html.replace(mt.full,'<img'+mt.pre+'src="'+dl+'"'+mt.post+'>'); i++; return next();
        });
      }
      return Promise.resolve().then(next);
    }

    setHTML(opts.value||'');
    return { getHTML:getHTML, setHTML:setHTML, focus:focus, uploadInlineImages:uploadInlineImages, canvas:canvas, host:host };
  }

  window.DocEditor={ mount:mount, openImage:openImage, closeImage:closeLightbox };
})();
