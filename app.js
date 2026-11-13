"use strict";
const STORE_NAMES = ["이마트","탑마트","롯데맥스","제일종합","5일장"];
const DB_NAME = "today-shopping-pwa";
const DB_VERSION = 2; // v2: 상품명 기록(products) 저장소 추가. 기존 날짜별 데이터(days)는 그대로 유지됨
let db;
const localDateString = (d) => {
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
};
let currentDate = localDateString(new Date());
let selectedStore = 0;
let editingId = null;
let photoData = "";
let deferredInstallPrompt = null;
let dayData = null;
let products = []; // 과거에 입력한 상품 기록(메모리 사본)

const $ = (id) => document.getElementById(id);
const won = (n) => `${Number(n || 0).toLocaleString("ko-KR")}원`;
const blankDay = (date) => ({
  date,
  stores: [...STORE_NAMES, "나만의 마트"].map((name, i) => ({name, custom:i===5, items:[]})),
  finished: false,
  memo: ""
});
const id = () => `${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
const clamp = (v,a,b) => Math.min(b,Math.max(a,v));

/* ================= 저장소(IndexedDB) ================= */
function openDatabase(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{
      const d=request.result;
      if(!d.objectStoreNames.contains("days"))d.createObjectStore("days",{keyPath:"date"});
      if(!d.objectStoreNames.contains("products"))d.createObjectStore("products",{keyPath:"key"});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
const reqP = (r) => new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
const idbGet = (s,k) => reqP(db.transaction(s,"readonly").objectStore(s).get(k));
const idbAll = (s) => reqP(db.transaction(s,"readonly").objectStore(s).getAll());
function idbWrite(s,fn){
  return new Promise((res,rej)=>{
    const t=db.transaction(s,"readwrite");fn(t.objectStore(s));
    t.oncomplete=()=>res();t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error);
  });
}
const getDay = (date) => idbGet("days",date).then(r=>r||null);
const hasShopping = (d) => (d.stores||[]).some(s=>s.items&&s.items.length);
let shoppingDays = new Set(); // 장 본 날(상품이 1개 이상 있는 날짜)
async function refreshShoppingDays(){shoppingDays=new Set((await idbAll("days")).filter(hasShopping).map(d=>d.date));}
const saveDay = async () => {
  await idbWrite("days",st=>st.put(dayData));
  if(hasShopping(dayData))shoppingDays.add(dayData.date);else shoppingDays.delete(dayData.date);
};

async function loadDate(date){
  currentDate=date;
  dayData=await getDay(date)||blankDay(date);
  if(!dayData.stores || dayData.stores.length!==6) dayData=blankDay(date);
  $("dateLabel").textContent=date.replace(/-/g,". ");
  setNotice(dayData.finished ? "종료 처리된 날짜의 내역을 보고 있습니다. 수정도 가능합니다." : "");
  resetForm();render();
}
function setNotice(text){const n=$("dateNotice");n.textContent=text;n.hidden=!text;}
function storeItems(){return dayData.stores[selectedStore].items;}
function amount(item){return Math.max(0,Number(item.price)||0)*Math.max(0,Number(item.qty)||0);}
function nameCompare(a,b){return a.name.localeCompare(b.name,"ko-KR",{sensitivity:"base"});}
function sortedItems(items,done){return items.filter(x=>!!x.done===done).sort(nameCompare);}
function totals(){
  let purchased=0,remaining=0;
  dayData.stores.forEach(s=>s.items.forEach(it=>{if(it.done)purchased+=amount(it);else remaining+=amount(it);}));
  return {purchased,remaining,total:purchased+remaining};
}

/* ================= 한글 초성 검색 ================= */
const CHO = [..."ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"];
function hangul(ch){
  const c=ch.charCodeAt(0)-0xAC00;
  return (c<0||c>11171)?null:{cho:Math.floor(c/588),jung:Math.floor((c%588)/28),jong:c%28};
}
function charMatch(q,n,isLast){
  if(q===n)return true;
  const qc=CHO.indexOf(q);               // 입력이 초성(ㅇ, ㅂ …)이면 글자의 초성과 비교
  if(qc>=0){const np=hangul(n);return !!np&&np.cho===qc;}
  const qp=hangul(q),np=hangul(n);        // 마지막 글자를 입력 중이면 받침 유무와 상관없이 비교(예: '우' → '운')
  return !!(isLast&&qp&&np&&qp.jong===0&&qp.cho===np.cho&&qp.jung===np.jung);
}
const normText = (s) => String(s).toLowerCase().replace(/\s+/g,"");
// 반환: 일치 시작 위치(0=앞부분 일치), 없으면 -1
function matchIndex(name,query){
  const n=normText(name),q=normText(query);
  if(!q)return 0;
  for(let s=0;s+q.length<=n.length;s++){
    let ok=true;
    for(let i=0;i<q.length;i++){if(!charMatch(q[i],n[s+i],i===q.length-1)){ok=false;break;}}
    if(ok)return s;
  }
  return -1;
}

/* ================= 상품명 기록 ================= */
const prodKey = (n) => normText(n);
async function loadProducts(){
  products=await idbAll("products");
  if(products.length)return;
  // 처음 한 번: 이미 저장된 날짜별 상품들을 기록으로 가져오기
  const days=(await idbAll("days")).sort((a,b)=>a.date<b.date?-1:1),map=new Map();
  days.forEach(d=>(d.stores||[]).forEach((s,si)=>(s.items||[]).forEach(it=>{
    if(!it.name)return;
    const k=prodKey(it.name);let p=map.get(k);
    if(!p){p={key:k,name:it.name,count:0,price:0,prices:{},photo:"",last:0};map.set(k,p);}
    p.name=it.name;p.count++;p.price=it.price;p.prices[si]=it.price;if(it.photo)p.photo=it.photo;p.last=Date.parse(d.date)||0;
  })));
  products=[...map.values()];
  if(products.length)await idbWrite("products",st=>products.forEach(p=>st.put(p)));
}
async function rememberProduct(name,price,photo,countUp){
  try{
    const key=prodKey(name);let p=products.find(x=>x.key===key);
    if(!p){p={key,name,count:0,price:0,prices:{},photo:"",last:0};products.push(p);}
    p.name=name;p.price=price;p.prices[selectedStore]=price;p.last=Date.now();
    if(countUp)p.count++;
    if(photo)p.photo=photo;
    await idbWrite("products",st=>st.put(p));
  }catch(err){console.warn("상품 기록 저장 실패",err);}
}
async function forgetProduct(key){
  products=products.filter(p=>p.key!==key);
  try{await idbWrite("products",st=>st.delete(key));}catch(err){console.warn(err);}
}

/* ================= 화면 그리기 ================= */
function render(){
  const sums=totals();
  $("purchasedTotal").textContent=won(sums.purchased);
  $("dayTotal").textContent=won(sums.total);
  $("storeBtnName").textContent=dayData.stores[selectedStore].name;
  $("memoBtn").classList.toggle("has-memo",!!(dayData.memo&&dayData.memo.trim()));
  const store=dayData.stores[selectedStore], storeTotal=store.items.reduce((a,x)=>a+amount(x),0);
  $("selectedStoreName").textContent=store.name;$("selectedStoreTotal").textContent=won(storeTotal);
  $("customStoreNameBtn").hidden=selectedStore!==5;
  $("itemCount").textContent=`${store.items.length}개`;
  const todo=sortedItems(store.items,false),done=sortedItems(store.items,true);
  $("todoCount").textContent=todo.length;$("doneCount").textContent=done.length;
  renderList($("todoList"),todo,false);renderList($("doneList"),done,true);
  $("storeSummary").innerHTML="";
  dayData.stores.forEach(s=>{
    const sum=s.items.reduce((a,x)=>a+amount(x),0);
    const row=document.createElement("div");row.className="store-summary-row";
    const label=document.createElement("span");label.textContent=s.name;
    const value=document.createElement("strong");value.textContent=won(sum);
    const count=document.createElement("small");count.textContent=`${s.items.length}개 상품`;
    value.appendChild(count);row.append(label,value);$("storeSummary").appendChild(row);
  });
}
function renderList(target,items,done){
  target.innerHTML="";
  if(!items.length){const e=document.createElement("div");e.className="empty-state";e.textContent=done?"아직 구매 완료한 상품이 없습니다.":"등록된 상품이 없습니다. 위에서 상품을 추가해 주세요.";target.appendChild(e);return;}
  items.forEach(item=>{
    const row=document.createElement("div");row.className="item-row"+(item.photo?"":" no-photo")+(done?" done":"");
    const check=document.createElement("input");check.type="checkbox";check.className="item-check";check.checked=done;check.setAttribute("aria-label",`${item.name} 구매 완료`);
    check.addEventListener("change",async()=>{item.done=check.checked;await saveDay();render();});
    row.appendChild(check);
    if(item.photo){const img=document.createElement("img");img.className="item-photo";img.src=item.photo;img.alt=item.name;row.appendChild(img);}
    const main=document.createElement("div");main.className="item-main";
    const nm=document.createElement("div");nm.className="item-name";nm.textContent=item.name;
    const meta=document.createElement("div");meta.className="item-meta";meta.textContent=`단가 ${won(item.price)} · 수량 ${item.qty}`;
    main.append(nm,meta);
    const actions=document.createElement("div");actions.className="item-actions";
    const edit=document.createElement("button");edit.type="button";edit.textContent="수정";edit.addEventListener("click",()=>beginEdit(item.id));
    const del=document.createElement("button");del.type="button";del.textContent="삭제";del.addEventListener("click",()=>deleteItem(item.id));
    actions.append(edit,del);main.appendChild(actions);row.appendChild(main);
    const sum=document.createElement("div");sum.className="item-amount";sum.textContent=won(amount(item));row.appendChild(sum);
    target.appendChild(row);
  });
}

/* ================= 입력 폼 ================= */
function resetForm(){
  editingId=null;photoData="";$("itemForm").reset();$("itemQty").value=1;
  updatePhotoUI();hideSuggestions();
  $("saveItemBtn").innerHTML="상품<br>추가";$("cancelEditBtn").hidden=true;updateFormAmount();
}
function updateFormAmount(){
  const p=Math.max(0,Number($("itemPrice").value)||0),q=Math.max(0,Number($("itemQty").value)||0);
  $("formAmount").textContent=won(p*q);
}
function updatePhotoUI(){
  const has=!!photoData;
  $("photoPreview").hidden=!has;if(has)$("photoPreview").src=photoData;
  $("photoSlotLabel").hidden=has;
}
function setPhoto(url){photoData=url||"";updatePhotoUI();}
function beginEdit(itemId){
  const item=storeItems().find(x=>x.id===itemId);if(!item)return;
  editingId=itemId;$("itemName").value=item.name;$("itemPrice").value=item.price;$("itemQty").value=item.qty;
  setPhoto(item.photo||"");hideSuggestions();
  $("saveItemBtn").innerHTML="상품<br>수정";$("cancelEditBtn").hidden=false;updateFormAmount();
  $("itemForm").scrollIntoView({behavior:"smooth",block:"start"});
}
async function deleteItem(itemId){
  if(!await ask("상품 삭제","이 상품을 목록에서 삭제할까요?"))return;
  const items=storeItems(),idx=items.findIndex(x=>x.id===itemId);if(idx>=0)items.splice(idx,1);
  if(editingId===itemId)resetForm();await saveDay();render();
}
function ask(title,message){
  return new Promise(resolve=>{
    $("dialogTitle").textContent=title;$("dialogMessage").textContent=message;
    const dialog=$("confirmDialog");dialog.showModal();
    dialog.addEventListener("close",()=>resolve(dialog.returnValue==="ok"),{once:true});
  });
}

/* ================= 상품명 자동완성(초성 검색) ================= */
function hideSuggestions(){const b=$("suggestBox");b.hidden=true;b.innerHTML="";}
function showSuggestions(){
  const q=$("itemName").value;
  const list=products.map(p=>({p,i:matchIndex(p.name,q)})).filter(x=>x.i>=0)
    .sort((a,b)=>((a.i===0?0:1)-(b.i===0?0:1))||nameCompare(a.p,b.p)).slice(0,60);
  const box=$("suggestBox");box.innerHTML="";
  if(!list.length){box.hidden=true;return;}
  const head=document.createElement("div");head.className="suggest-head";
  head.textContent=q.trim()?`이전에 입력한 상품 ${list.length}개 (앞부분 일치 → 가나다순)`:`이전에 입력한 상품 ${list.length}개 (가나다순)`;
  box.appendChild(head);
  list.forEach(({p})=>{
    const row=document.createElement("div");row.className="suggest-item";
    const pick=document.createElement("button");pick.type="button";pick.className="suggest-pick";
    const b=document.createElement("b");b.textContent=p.name;
    const price=p.prices&&p.prices[selectedStore]!=null?p.prices[selectedStore]:p.price;
    const s=document.createElement("small");s.textContent=`최근 단가 ${won(price)}${p.count?` · ${p.count}회 입력`:""}`;
    pick.append(b,s);pick.addEventListener("click",()=>applySuggestion(p));
    const del=document.createElement("button");del.type="button";del.className="suggest-del";del.textContent="✕";del.setAttribute("aria-label",`${p.name} 기록 삭제`);
    del.addEventListener("click",async()=>{if(await ask("기록 삭제",`'${p.name}'을(를) 입력 기록에서 지울까요? (이미 담은 목록은 그대로입니다)`)){await forgetProduct(p.key);showSuggestions();}});
    row.append(pick,del);box.appendChild(row);
  });
  box.hidden=false;
  const fr=$("itemForm").getBoundingClientRect(),ir=$("itemName").getBoundingClientRect();
  box.style.top=`${ir.bottom-fr.top+4}px`;
  const vv=window.visualViewport,vh=vv?vv.height:window.innerHeight;
  const room=vh-ir.bottom-16;
  box.style.maxHeight=`${clamp(room,110,260)}px`;
}
function applySuggestion(p){
  $("itemName").value=p.name;
  if(!$("itemPrice").value){
    const pr=p.prices&&p.prices[selectedStore]!=null?p.prices[selectedStore]:p.price;
    if(pr)$("itemPrice").value=pr;
  }
  if(!photoData&&p.photo)setPhoto(p.photo);
  updateFormAmount();hideSuggestions();
  $("itemPrice").focus();$("itemPrice").select();
}
$("itemName").addEventListener("focus",()=>{
  showSuggestions();
  setTimeout(()=>$("itemForm").scrollIntoView({block:"start",behavior:"smooth"}),250);
});
$("itemName").addEventListener("input",showSuggestions);
$("itemName").addEventListener("blur",()=>setTimeout(hideSuggestions,150));
$("suggestBox").addEventListener("mousedown",e=>e.preventDefault()); // 목록을 누를 때 입력창 포커스가 풀리지 않게

/* ================= 사진 추가 ================= */
$("photoBtn").addEventListener("click",()=>{
  $("recropBtn").hidden=!photoData;$("removePhotoBtn").hidden=!photoData;
  $("photoSheet").showModal();
});
const closeSheet=()=>$("photoSheet").close();
$("closeSheetBtn").addEventListener("click",closeSheet);
$("shootBtn").addEventListener("click",()=>{closeSheet();$("cameraInput").click();});
$("galleryBtn").addEventListener("click",()=>{closeSheet();$("galleryInput").click();});
$("presetBtn").addEventListener("click",()=>{closeSheet();openPicker("preset");});
$("libraryBtn").addEventListener("click",()=>{closeSheet();openPicker("library");});
$("removePhotoBtn").addEventListener("click",()=>{closeSheet();setPhoto("");});
$("recropBtn").addEventListener("click",async()=>{
  closeSheet();if(!photoData)return;
  try{const url=await openCrop(await toCanvas(photoData));if(url)setPhoto(url);}
  catch{alert("사진을 불러오지 못했습니다.");}
});
async function handleFile(file){
  if(!file)return;
  if(!file.type.startsWith("image/")){alert("이미지 파일을 선택해 주세요.");return;}
  try{const url=await openCrop(await toCanvas(file));if(url)setPhoto(url);}
  catch{alert("사진을 불러오지 못했습니다.");}
}
for(const inputId of ["cameraInput","galleryInput"]){
  $(inputId).addEventListener("change",async e=>{const f=e.target.files&&e.target.files[0];e.target.value="";await handleFile(f);});
}
// 파일 또는 주소(data URL 등) → 캔버스(긴 변 최대 1800px)
async function toCanvas(src){
  const img=new Image();let url=src,revoke=false;
  if(src instanceof Blob){url=URL.createObjectURL(src);revoke=true;}
  try{
    await new Promise((res,rej)=>{img.onload=res;img.onerror=rej;img.src=url;});
    const scale=Math.min(1,1800/Math.max(img.naturalWidth,img.naturalHeight));
    const c=document.createElement("canvas");
    c.width=Math.max(1,Math.round(img.naturalWidth*scale));c.height=Math.max(1,Math.round(img.naturalHeight*scale));
    c.getContext("2d").drawImage(img,0,0,c.width,c.height);
    return c;
  }finally{if(revoke)URL.revokeObjectURL(url);}
}

/* ----- 기본 상품 그림 / 내 사진 보관함 ----- */
let pickerMode="preset";
function openPicker(mode){
  pickerMode=mode;
  $("pickerTitle").textContent=mode==="preset"?"기본 상품 그림":"내 사진 보관함";
  $("pickerSearch").value="";renderPicker();$("pickerDialog").showModal();
}
function renderPicker(){
  const q=$("pickerSearch").value,grid=$("pickerGrid");grid.innerHTML="";
  const base=pickerMode==="preset"
    ?(typeof PRESETS!=="undefined"?PRESETS:[]).map(p=>({label:p.n,preset:p}))
    :products.filter(p=>p.photo).map(p=>({label:p.name,photo:p.photo}));
  const list=base.filter(x=>matchIndex(x.label,q)>=0).sort((a,b)=>a.label.localeCompare(b.label,"ko-KR"));
  if(!list.length){
    const e=document.createElement("div");e.className="empty-state";
    e.textContent=pickerMode==="library"&&!q?"아직 보관된 사진이 없습니다. 사진을 넣어 상품을 추가하면 여기에 쌓입니다.":"검색 결과가 없습니다.";
    grid.appendChild(e);return;
  }
  list.forEach(x=>{
    const t=document.createElement("button");t.type="button";t.className="pick-tile";
    const vis=document.createElement("div");vis.className="vis";
    if(x.photo||(x.preset&&x.preset.src)){const im=document.createElement("img");im.src=x.photo||x.preset.src;im.alt=x.label;vis.appendChild(im);}
    else vis.textContent=x.preset.e;
    const lb=document.createElement("span");lb.textContent=x.label;
    t.append(vis,lb);
    t.addEventListener("click",async()=>{
      try{setPhoto(x.photo||await presetToDataURL(x.preset));}catch{alert("그림을 불러오지 못했습니다.");return;}
      if(!$("itemName").value.trim())$("itemName").value=x.label;
      $("pickerDialog").close();
    });
    grid.appendChild(t);
  });
}
async function presetToDataURL(p){
  const c=document.createElement("canvas");c.width=c.height=240;const g=c.getContext("2d");
  if(p.src){
    const src=await toCanvas(p.src),s=Math.min(src.width,src.height);
    g.drawImage(src,(src.width-s)/2,(src.height-s)/2,s,s,0,0,240,240);
  }else{
    g.fillStyle="#eef5f2";g.fillRect(0,0,240,240);
    g.font='150px "Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",sans-serif';
    g.textAlign="center";g.textBaseline="middle";g.fillText(p.e,120,130);
  }
  return c.toDataURL("image/jpeg",.85);
}
$("pickerSearch").addEventListener("input",renderPicker);
$("pickerClose").addEventListener("click",()=>$("pickerDialog").close());

/* ----- 사진 자르기(crop) ----- */
const crop={src:null,dw:0,dh:0,r:{x:0,y:0,w:0,h:0},square:true,drag:null,result:null};
const CROP_MIN=24;
function openCrop(srcCanvas){
  return new Promise(resolve=>{
    crop.src=srcCanvas;crop.result=null;crop.drag=null;
    const d=$("cropDialog");d.showModal();
    requestAnimationFrame(()=>layoutCrop());
    d.addEventListener("close",()=>resolve(crop.result),{once:true});
  });
}
function layoutCrop(){
  const st=$("cropStage"),W=st.clientWidth-8,H=st.clientHeight-8;
  if(W<=0||H<=0||!crop.src)return;
  const s=Math.min(W/crop.src.width,H/crop.src.height);
  crop.dw=Math.round(crop.src.width*s);crop.dh=Math.round(crop.src.height*s);
  const area=$("cropArea"),cv=$("cropCanvas"),dpr=Math.min(2,window.devicePixelRatio||1);
  area.style.width=crop.dw+"px";area.style.height=crop.dh+"px";
  cv.width=Math.round(crop.dw*dpr);cv.height=Math.round(crop.dh*dpr);
  cv.getContext("2d").drawImage(crop.src,0,0,cv.width,cv.height);
  const w=crop.dw*.8,h=crop.dh*.8,sq=Math.min(w,h);
  const rw=crop.square?sq:w,rh=crop.square?sq:h;
  crop.r={x:(crop.dw-rw)/2,y:(crop.dh-rh)/2,w:rw,h:rh};
  drawBox();
}
function drawBox(){
  const b=$("cropBox"),r=crop.r;
  b.style.left=r.x+"px";b.style.top=r.y+"px";b.style.width=r.w+"px";b.style.height=r.h+"px";
}
function rectFrom(ax,ay,px,py){
  let w=Math.abs(px-ax),h=Math.abs(py-ay);
  if(crop.square){const s=Math.min(w,h);w=h=s;}
  return {x:px>=ax?ax:ax-w,y:py>=ay?ay:ay-h,w,h};
}
function cropPoint(e){
  const rc=$("cropArea").getBoundingClientRect();
  return {x:clamp(e.clientX-rc.left,0,crop.dw),y:clamp(e.clientY-rc.top,0,crop.dh)};
}
$("cropArea").addEventListener("pointerdown",e=>{
  const p=cropPoint(e),r=crop.r,h=e.target.dataset&&e.target.dataset.h;
  if(h){
    const ax=(h==="nw"||h==="sw")?r.x+r.w:r.x, ay=(h==="nw"||h==="ne")?r.y+r.h:r.y;
    crop.drag={mode:"rect",ax,ay};
  }else if(e.target===$("cropBox")){
    crop.drag={mode:"move",ox:p.x-r.x,oy:p.y-r.y};
  }else crop.drag={mode:"rect",ax:p.x,ay:p.y}; // 빈 곳을 끌면 새로 선택
  $("cropArea").setPointerCapture(e.pointerId);e.preventDefault();
});
$("cropArea").addEventListener("pointermove",e=>{
  const d=crop.drag;if(!d)return;
  const p=cropPoint(e);
  if(d.mode==="move"){
    crop.r.x=clamp(p.x-d.ox,0,crop.dw-crop.r.w);crop.r.y=clamp(p.y-d.oy,0,crop.dh-crop.r.h);
  }else{
    const n=rectFrom(d.ax,d.ay,p.x,p.y);
    if(n.w>=CROP_MIN&&n.h>=CROP_MIN)crop.r=n;
  }
  drawBox();
});
const endDrag=()=>{crop.drag=null;};
$("cropArea").addEventListener("pointerup",endDrag);
$("cropArea").addEventListener("pointercancel",endDrag);
$("cropRatioBtn").addEventListener("click",()=>{
  crop.square=!crop.square;
  $("cropRatioBtn").textContent=crop.square?"비율: 정사각형":"비율: 자유";
  if(crop.square){
    const r=crop.r,s=Math.min(r.w,r.h);crop.r={x:r.x+(r.w-s)/2,y:r.y+(r.h-s)/2,w:s,h:s};drawBox();
  }
});
$("cropRotateBtn").addEventListener("click",()=>{
  const s=crop.src,c=document.createElement("canvas");c.width=s.height;c.height=s.width;
  const g=c.getContext("2d");g.translate(c.width,0);g.rotate(Math.PI/2);g.drawImage(s,0,0);
  crop.src=c;layoutCrop();
});
$("cropCancelBtn").addEventListener("click",()=>$("cropDialog").close());
$("cropApplyBtn").addEventListener("click",()=>{
  const r=crop.r,k=crop.src.width/crop.dw;
  const sx=r.x*k,sy=r.y*(crop.src.height/crop.dh),sw=r.w*k,sh=r.h*(crop.src.height/crop.dh);
  const scale=Math.min(1,720/Math.max(sw,sh));
  const out=document.createElement("canvas");out.width=Math.max(1,Math.round(sw*scale));out.height=Math.max(1,Math.round(sh*scale));
  out.getContext("2d").drawImage(crop.src,sx,sy,sw,sh,0,0,out.width,out.height);
  crop.result=out.toDataURL("image/jpeg",.85);
  $("cropDialog").close();
});
window.addEventListener("resize",()=>{if($("cropDialog").open)layoutCrop();});

/* ================= 폼 제출 및 기타 버튼 ================= */
$("itemPrice").addEventListener("input",updateFormAmount);$("itemQty").addEventListener("input",updateFormAmount);
$("cancelEditBtn").addEventListener("click",resetForm);
$("itemForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const name=$("itemName").value.trim(),price=Number($("itemPrice").value),qty=Number($("itemQty").value);
  if(!name||!Number.isFinite(price)||price<0||!Number.isInteger(qty)||qty<1){alert("상품명, 0원 이상의 단가, 1개 이상의 정수 수량을 입력해 주세요.");return;}
  const items=storeItems(),wasEditing=!!editingId;
  if(editingId){const old=items.find(x=>x.id===editingId);if(old){old.name=name;old.price=price;old.qty=qty;old.photo=photoData;}}
  else items.push({id:id(),name,price,qty,photo:photoData,done:false});
  await saveDay();
  await rememberProduct(name,price,photoData,!wasEditing);
  resetForm();render();
});
$("newDayBtn").addEventListener("click",async()=>{
  const date=localDateString(new Date());
  if(date===currentDate){if(dayData.stores.some(s=>s.items.length)&&!await ask("새 장보기 시작","오늘 날짜의 기존 목록은 그대로 보관됩니다. 목록을 초기화하지 않고 오늘 날짜를 다시 엽니다."))return;}
  await loadDate(date);
});
$("finishDayBtn").addEventListener("click",async()=>{
  if(!await ask("장보기 종료","이 날짜의 장보기 내역을 저장하고 종료 표시할까요? 과거 내역은 보관되며 언제든 다시 열 수 있습니다."))return;
  dayData.finished=true;await saveDay();render();setNotice("장보기가 종료되었습니다. 내역은 이 기기에 보관됩니다.");
});
$("customStoreNameBtn").addEventListener("click",async()=>{
  const name=prompt("여섯 번째 마트 이름을 입력하세요.",dayData.stores[5].name);
  if(name&&name.trim()){dayData.stores[5].name=name.trim().slice(0,24);await saveDay();render();}
});

/* ================= 달력 ================= */
let calYear=0,calMonth=0;
const pad2=(n)=>String(n).padStart(2,"0");
function renderCalendar(){
  $("calTitle").textContent=`${calYear}년 ${calMonth+1}월`;
  const grid=$("calGrid");grid.innerHTML="";
  const start=new Date(calYear,calMonth,1).getDay(),days=new Date(calYear,calMonth+1,0).getDate(),today=localDateString(new Date());
  for(let i=0;i<start;i++)grid.appendChild(document.createElement("span"));
  for(let d=1;d<=days;d++){
    const ds=`${calYear}-${pad2(calMonth+1)}-${pad2(d)}`,shop=shoppingDays.has(ds);
    const b=document.createElement("button");b.type="button";b.textContent=d;
    b.className="cal-day"+(shop?" shop":"")+(ds===currentDate?" sel":"")+(ds===today?" today":"");
    b.setAttribute("aria-label",`${ds.replace(/-/g,". ")}${shop?" 장 본 날":""}`);
    b.addEventListener("click",async()=>{$("calendarDialog").close();await loadDate(ds);});
    grid.appendChild(b);
  }
}
function moveMonth(delta){const d=new Date(calYear,calMonth+delta,1);calYear=d.getFullYear();calMonth=d.getMonth();renderCalendar();}
$("dateBtn").addEventListener("click",()=>{
  const [y,m]=currentDate.split("-").map(Number);calYear=y;calMonth=m-1;renderCalendar();$("calendarDialog").showModal();
});
$("calPrev").addEventListener("click",()=>moveMonth(-1));
$("calNext").addEventListener("click",()=>moveMonth(1));
$("calClose").addEventListener("click",()=>$("calendarDialog").close());
$("calToday").addEventListener("click",async()=>{$("calendarDialog").close();await loadDate(localDateString(new Date()));});

/* ================= 장보기(마트) 선택 ================= */
$("storeSelectBtn").addEventListener("click",()=>{
  const box=$("storeChoices");box.innerHTML="";
  dayData.stores.forEach((s,i)=>{
    const b=document.createElement("button");b.type="button";b.className="store-choice"+(i===selectedStore?" active":"");
    const n=document.createElement("span");n.textContent=s.name;
    const t=document.createElement("small");t.textContent=`${won(s.items.reduce((x,it)=>x+amount(it),0))} · ${s.items.length}개`;
    b.append(n,t);
    b.addEventListener("click",()=>{
      if(i!==selectedStore){selectedStore=i;if(editingId)resetForm();hideSuggestions();render();}
      $("storeDialog").close();
    });
    box.appendChild(b);
  });
  $("storeDialog").showModal();
});
$("storeClose").addEventListener("click",()=>$("storeDialog").close());

/* ================= 메모 ================= */
function memoMeta(){
  $("memoMeta").textContent=dayData.memoUpdated?`마지막 저장: ${new Date(dayData.memoUpdated).toLocaleString("ko-KR")}`:"아직 저장된 메모가 없습니다.";
}
$("memoBtn").addEventListener("click",()=>{
  $("memoTitle").textContent=`메모 · ${currentDate.replace(/-/g,". ")}`;
  $("memoText").value=dayData.memo||"";memoMeta();$("memoDialog").showModal();
});
$("memoClear").addEventListener("click",()=>{$("memoText").value="";$("memoText").focus();});
$("memoCancel").addEventListener("click",()=>$("memoDialog").close());
$("memoSave").addEventListener("click",async()=>{
  const t=$("memoText").value.trim().slice(0,2000);
  dayData.memo=t;dayData.memoUpdated=t?Date.now():0;
  await saveDay();$("memoDialog").close();render();
});
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredInstallPrompt=e;$("installBtn").hidden=false;});
$("installBtn").addEventListener("click",async()=>{
  if(!deferredInstallPrompt)return;
  deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$("installBtn").hidden=true;
});

// 상단 고정 영역 높이를 측정해서, 입력창이 고정 영역에 가려지지 않게 함
function trackStickyHeight(){
  const el=$("stickyTop"),set=()=>document.documentElement.style.setProperty("--sticky-h",el.offsetHeight+"px");
  set();if("ResizeObserver" in window)new ResizeObserver(set).observe(el);else window.addEventListener("resize",set);
}
trackStickyHeight();

if("serviceWorker" in navigator){window.addEventListener("load",()=>navigator.serviceWorker.register("./service-worker.js").catch(err=>console.warn("오프라인 기능 등록 실패",err)));}
(async()=>{
  try{db=await openDatabase();await loadProducts();await refreshShoppingDays();await loadDate(currentDate);}
  catch(err){console.error(err);alert("기기 저장소를 열지 못했습니다. 브라우저 설정을 확인해 주세요.");}
})();
