import {createServer,type Server} from 'node:http';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {safeRequest,publicAddress,fetchProfile,profile} from '../src/index.js';
let server:Server,origin:string,hits=0;
beforeAll(async()=>{
 server=createServer((req,res)=>{
  if(req.url==='/redirect'){res.writeHead(302,{Location:origin+'/profile'});res.end();return;}
  if(req.url==='/large'){res.end('x'.repeat(10000));return;}
  hits++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(profile(origin,'platform',[])));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
});
afterAll(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
it('rejects special-use and IPv4-mapped private addresses even for an enrolled origin',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.100.100.200','192.168.1.1','198.18.0.1','203.0.113.4','::1','::ffff:127.0.0.1','fc00::1','fe80::1'])expect(publicAddress(ip),ip).toBe(false);
 expect(publicAddress('8.8.8.8')).toBe(true);expect(publicAddress('2001:4860:4860::8888')).toBe(true);
 await expect(safeRequest('https://127.0.0.1/profile',{allowedOrigins:new Set(['https://127.0.0.1'])})).rejects.toThrow('profile_address_not_allowed');
});
it('never follows redirects and caps streamed response size',async()=>{
 const options={allowedOrigins:new Set([origin]),allowLoopback:true};
 await expect(safeRequest(origin+'/redirect',options)).rejects.toThrow('profile_redirect_forbidden');
 await expect(safeRequest(origin+'/large',{...options,maxBytes:100})).rejects.toThrow('profile_too_large');
});
it('deduplicates discovery and caches profiles for at least a minute',async()=>{
 const count=hits,url=origin+'/profile',allowed=new Set([origin]);
 const values=await Promise.all([fetchProfile(url,allowed,true),fetchProfile(url,allowed,true)]);
 expect(values[0]).toEqual(values[1]);await fetchProfile(url,allowed,true);expect(hits-count).toBe(1);
});
