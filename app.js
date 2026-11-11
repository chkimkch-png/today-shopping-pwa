const STORE_NAMES = ["이마트","탑마트","롯데맥스","제일종합","5일장"];
const CUSTOM_STORE = "직접 입력";
const DB_NAME = "today-shopping-pwa";
const DB_VERSION = 1;
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

const $ = (id) => document.getElementById(id);
const won = (n) => `${Number(n || 0).toLocaleString("ko-KR")}원`;
const blankDay = (date) => ({
  date,
  stores: [...STORE_NAMES, "나만의 마트"].map((name, i) => ({name, custom:i===5, items:[]})),
  finished: false
});
const id = () => `${Date.now()}-${Math.random().toString(36).slice(2,9)}`;

function openDatabase(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{const d=request.result;if(!d.objectStoreNames.contains("days"))d.createObjectStore("days",{keyPath:"date"});};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
function getDay(date){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("days","readonly"), req=tx.objectStore("days").get(date);
    req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);
  });
}
function saveDay(){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("days","readwrite");tx.objectStore("days").put(dayData);
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
  });
}
async function loadDate(date){
  currentDate=date;
  dayData=await getDay(date)||blankDay(date);
  if(!dayData.stores || dayData.stores.length!==6) dayData=blankDay(date);
  $("shoppingDate").value=date;
  $("dateNotice").textContent=dayData.finished ? "종료 처리된 날짜의 내역을 보고 있습니다. 수정도 가능합니다." : "날짜별 내역은 이 기기에 자동 저장됩니다.";
  resetForm();render();
}
function storeItems(){return dayData.stores[selectedStore].items;}
function amount(item){return Math.max(0,Number(item.price)||0)*Math.max(0,Number(item.qty)||0);}
function nameCompare(a,b){return a.name.localeCompare(b.name,"ko-KR",{sensitivity:"base"});}
function sortedItems(items,done){return items.filter(x=>!!x.done===done).sort(nameCompare);}
function totals(){
  let purchased=0,remaining=0;
  dayData.stores.forEach(s=>s.items.forEach(it=>{if(it.done)purchased+=amount(it);else remaining+=amount(it);}));
  return {purchased,remaining,total:purchased+remaining};
}
function render(){
  const sums=totals();
  $("purchasedTotal").textContent=won(sums.purchased);
  $("remainingTotal").textContent=won(sums.remaining);
  $("dayTotal").textContent=won(sums.total);
  $("storeTabs").innerHTML="";
  dayData.stores.forEach((s,i)=>{
    const b=document.createElement("button");b.className="store-tab"+(i===selectedStore?" active":"");
    b.textContent=s.name;b.addEventListener("click",()=>{selectedStore=i;resetForm();render();});
    $("storeTabs").appendChild(b);
  });
  const store=dayData.stores[selectedStore], storeTotal=store.items.reduce((a,x)=>a+amount(x),0);
  $("selectedStoreName").textContent=store.name;$("selectedStoreTotal").textContent=won(storeTotal);
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
    const edit=document.createElement("button");edit.textContent="수정";edit.addEventListener("click",()=>beginEdit(item.id));
    const del=document.createElement("button");del.textContent="삭제";del.addEventListener("click",()=>deleteItem(item.id));
    actions.append(edit,del);main.appendChild(actions);row.appendChild(main);
    const sum=document.createElement("div");sum.className="item-amount";sum.textContent=won(amount(item));row.appendChild(sum);
    target.appendChild(row);
  });
}
function resetForm(){
  editingId=null;photoData="";$("itemForm").reset();$("itemQty").value=1;
  $("photoPreview").hidden=true;$("clearPhotoBtn").hidden=true;
  $("saveItemBtn").textContent="상품 추가";$("cancelEditBtn").hidden=true;updateFormAmount();
}
function updateFormAmount(){
  const p=Math.max(0,Number($("itemPrice").value)||0),q=Math.max(0,Number($("itemQty").value)||0);
  $("formAmount").innerHTML=`상품 금액 <strong>${won(p*q)}</strong>`;
}
function beginEdit(itemId){
  const item=storeItems().find(x=>x.id===itemId);if(!item)return;
  editingId=itemId;$("itemName").value=item.name;$("itemPrice").value=item.price;$("itemQty").value=item.qty;
  photoData=item.photo||"";$("photoPreview").src=photoData;$("photoPreview").hidden=!photoData;$("clearPhotoBtn").hidden=!photoData;
  $("saveItemBtn").textContent="상품 수정";$("cancelEditBtn").hidden=false;updateFormAmount();
  $("itemName").scrollIntoView({behavior:"smooth",block:"center"});
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
$("itemPrice").addEventListener("input",updateFormAmount);$("itemQty").addEventListener("input",updateFormAmount);
$("photoInput").addEventListener("change",async e=>{
  const file=e.target.files?.[0];if(!file)return;
  if(!file.type.startsWith("image/")){alert("이미지 파일을 선택해 주세요.");return;}
  try{photoData=await compressImage(file);$("photoPreview").src=photoData;$("photoPreview").hidden=false;$("clearPhotoBtn").hidden=false;}
  catch{alert("사진을 불러오지 못했습니다.");}
});
function compressImage(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onerror=reject;reader.onload=()=>{
      const img=new Image();img.onerror=reject;img.onload=()=>{
        const max=1000,scale=Math.min(1,max/Math.max(img.width,img.height));
        const canvas=document.createElement("canvas");canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);
        canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
        resolve(canvas.toDataURL("image/jpeg",.78));
      };img.src=reader.result;
    };reader.readAsDataURL(file);
  });
}
$("clearPhotoBtn").addEventListener("click",()=>{photoData="";$("photoPreview").hidden=true;$("clearPhotoBtn").hidden=true;$("photoInput").value="";});
$("cancelEditBtn").addEventListener("click",resetForm);
$("itemForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const name=$("itemName").value.trim(),price=Number($("itemPrice").value),qty=Number($("itemQty").value);
  if(!name||!Number.isFinite(price)||price<0||!Number.isInteger(qty)||qty<1){alert("상품명, 0원 이상의 단가, 1개 이상의 정수 수량을 입력해 주세요.");return;}
  const items=storeItems();
  if(editingId){const old=items.find(x=>x.id===editingId);if(old){old.name=name;old.price=price;old.qty=qty;old.photo=photoData;}}
  else items.push({id:id(),name,price,qty,photo:photoData,done:false});
  await saveDay();resetForm();render();
});
$("shoppingDate").addEventListener("change",e=>loadDate(e.target.value||localDateString(new Date())));
$("todayBtn").addEventListener("click",()=>loadDate(localDateString(new Date())));
$("newDayBtn").addEventListener("click",async()=>{
  const date=localDateString(new Date());
  if(date===currentDate){if(dayData.stores.some(s=>s.items.length)&&!await ask("새 장보기 시작","오늘 날짜의 기존 목록은 그대로 보관됩니다. 목록을 초기화하지 않고 오늘 날짜를 다시 엽니다."))return;}
  await loadDate(date);
});
$("finishDayBtn").addEventListener("click",async()=>{
  if(!await ask("장보기 종료","이 날짜의 장보기 내역을 저장하고 종료 표시할까요? 과거 내역은 보관되며 언제든 다시 열 수 있습니다."))return;
  dayData.finished=true;await saveDay();render();$("dateNotice").textContent="장보기가 종료되었습니다. 내역은 이 기기에 보관됩니다.";
});
$("customStoreNameBtn").addEventListener("click",async()=>{
  const name=prompt("여섯 번째 마트 이름을 입력하세요.",dayData.stores[5].name);
  if(name&&name.trim()){dayData.stores[5].name=name.trim().slice(0,24);await saveDay();render();}
});
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredInstallPrompt=e;$("installBtn").hidden=false;});
$("installBtn").addEventListener("click",async()=>{
  if(!deferredInstallPrompt)return;
  deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$("installBtn").hidden=true;
});
if("serviceWorker" in navigator){window.addEventListener("load",()=>navigator.serviceWorker.register("./service-worker.js").catch(err=>console.warn("오프라인 기능 등록 실패",err)));}
(async()=>{
  try{db=await openDatabase();await loadDate(currentDate);}
  catch(err){console.error(err);alert("기기 저장소를 열지 못했습니다. 브라우저 설정을 확인해 주세요.");}
})();
