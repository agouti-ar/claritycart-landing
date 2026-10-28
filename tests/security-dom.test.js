const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');const fs=require('node:fs');
const {parseHTML}=require('linkedom');
const payload='<img src=x onerror="globalThis.__xss=1"><svg onload="globalThis.__xss=2"></svg>';
function functionSource(file,start,end){const s=fs.readFileSync(file,'utf8');return s.slice(s.indexOf(start),s.indexOf(end,s.indexOf(start)));}
test('admin account values are text and callbacks never contain source data',()=>{
 const {document,Event}=parseHTML('<html><body><table><tbody id="users-tbody"></tbody></table></body></html>');
 const calls=[];const ctx={document,currentUserSession:{user:{email:'admin@example.com'}},applyFilters(){},
  togglePause:(...args)=>calls.push(args),confirmBlock:(...args)=>calls.push(args),confirmDelete:(...args)=>calls.push(args),openEditModal:(...args)=>calls.push(args),modifySubscription:(...args)=>calls.push(args)};
 vm.createContext(ctx);vm.runInContext(functionSource('admin.html','        function renderUsersTable','// Toggle Pause Widget'),ctx);
 const id="x');globalThis.__xss=3;//";ctx.renderUsersTable([{id,email:payload,store_domain:payload,plan:payload,query_count:0,query_limit:0}]);
 const tbody=document.getElementById('users-tbody');assert.equal(tbody.querySelectorAll('img,svg[onload],script,[onclick],[onerror]').length,0);
 assert.equal(tbody.querySelector('[data-safe-field="email"]').textContent,payload);assert.equal(tbody.querySelector('[data-safe-field="domain"]').textContent,payload);
 tbody.querySelector('[data-action="block"]').dispatchEvent(new Event('click'));assert.equal(calls[0][0],id);assert.equal(calls[0][2],payload);assert.equal(ctx.__xss,undefined);
});
test('admin toast renders malicious message as text',()=>{
 const {document}=parseHTML('<html><body><div id="toast-container"></div></body></html>');const ctx={document,setTimeout(){}};vm.createContext(ctx);
 vm.runInContext(functionSource('admin.html','        function showToast','        // Logout'),ctx);ctx.showToast(payload);
 assert.equal(document.querySelectorAll('img,[onerror],[onload]').length,0);assert.ok(document.getElementById('toast-container').textContent.includes(payload));
});
test('dashboard questions and prototype-like question names remain safe text',async()=>{
 const {document}=parseHTML('<html><body><div id="queries-container"></div><span id="total-usage"></span></body></html>');
 const data=[{question_text:payload,created_at:new Date().toISOString()},{question_text:'__proto__'},{question_text:'constructor'}];
 const ctx={document,console,fetchAccount:async()=>({query_count:3,query_limit:500,period_start:new Date().toISOString(),period_end:new Date(Date.now()+86400000).toISOString(),access_until:new Date(Date.now()+86400000).toISOString()}),supabaseClient:{from:()=>({select:()=>({eq:async()=>({data,count:3,error:null})})})}};
 vm.createContext(ctx);vm.runInContext(functionSource('dashboard.html','        async function updateUsageAndQueries','// Initialize dashboard UI once'),ctx);await ctx.updateUsageAndQueries('example.com',500,'Starter',false);
 assert.equal(document.querySelectorAll('img,[onerror],[onload],script').length,0);assert.ok(document.getElementById('queries-container').textContent.includes(payload));
 assert.equal(document.querySelectorAll('[data-question-text]').length,3);
});
