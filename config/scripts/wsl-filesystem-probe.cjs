const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
(async () => {
 const listed = spawnSync('wsl.exe', ['--list','--quiet'], {encoding:'utf16le',windowsHide:true});
 const distro = listed.stdout.replace(/\0/g,'').split(/\r?\n/).find(v=>v.trim()).trim();
 const made = spawnSync('wsl.exe', ['-d',distro,'--exec','bash','-c','printf IMAGE > /tmp/orca-kitty-fs-probe; stat -c "%h %i %s" /tmp/orca-kitty-fs-probe'],{encoding:'utf8',windowsHide:true});
 console.log('guest',made.status,made.stdout,made.stderr);
 const native = await fs.realpath(os.tmpdir());
 const linux = '/mnt/'+native[0].toLowerCase()+'/'+native.slice(3).replace(/\\/g,'/');
 for (const [label,p] of [['guest-image',`\\\\wsl.localhost\\${distro}\\tmp\\orca-kitty-fs-probe`],['guest-temp',`\\\\wsl.localhost\\${distro}\\tmp`],['drvfs-root',`\\\\wsl.localhost\\${distro}${linux.replace(/\//g,'\\')}`],['native-root',native]]) {
  for (const operation of ['realpath','lstat','open']) {
   try {
    if(operation==='realpath') console.log(label,operation,await fs.realpath(p));
    else if(operation==='lstat'){const s=await fs.lstat(p);console.log(label,operation,{file:s.isFile(),nlink:s.nlink,ino:s.ino,dev:s.dev,size:s.size});}
    else {const h=await fs.open(p,0);try {const s=await h.stat();console.log(label,operation,{file:s.isFile(),nlink:s.nlink,ino:s.ino,dev:s.dev,size:s.size}); if(s.isFile())console.log(label,'bytes',await h.readFile('utf8'));}finally{await h.close();}}
   }catch(e){console.log(label,operation,{code:e.code,syscall:e.syscall});}
  }
 }
 spawnSync('wsl.exe', ['-d',distro,'--exec','rm','-f','/tmp/orca-kitty-fs-probe'],{windowsHide:true});
})();
