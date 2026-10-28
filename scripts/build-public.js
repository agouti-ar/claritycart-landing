const fs=require('node:fs');const path=require('node:path');
const files=['index.html','dashboard.html','insights.html','admin.html','login.html','register.html','forgot-password.html','reset-password.html','privacy.html','terms.html','refund.html','test.html','clarity.js','billing-ui.js','demo.gif'];
const root=path.resolve(__dirname,'..'),out=path.join(root,'dist');
fs.mkdirSync(out,{recursive:true});
for(const entry of fs.readdirSync(out))if(!files.includes(entry))throw new Error('Unexpected build output; inspect before publishing: '+entry);
for(const file of files)fs.copyFileSync(path.join(root,file),path.join(out,file));
console.log('Built '+files.length+' explicitly allowed public assets. Backend, SQL, tests, docs and environment files are excluded.');
