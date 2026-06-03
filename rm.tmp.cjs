const fs=require('fs');const env=fs.readFileSync('.env.local','utf8');const m=env.match(/^DATABASE_URL\s*=\s*["']?([^"'\n]+)/m);const u=new URL(m[1]);const mysql=require('mysql2/promise');
(async()=>{const c=await mysql.createConnection({host:u.hostname,port:u.port||3306,user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),multipleStatements:true});
await c.query("CREATE DATABASE IF NOT EXISTS cavecms_mcpops CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
console.log('cavecms_mcpops ready');
await c.end();})().catch(e=>console.error(e.message))
