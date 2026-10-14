import {lookup} from 'node:dns/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import ipaddr from 'ipaddr.js';
import {DomainError} from '@yours/domain';
export function publicAddress(address:string):boolean{
 try{return ipaddr.process(address).range()==='unicast';}catch{return false;}
}
/** Resolve once and pin that address for the TLS connection. Redirects are
 * rejected and response size is bounded, including for allowlisted origins. */
export async function safeRequest(url:string,options:{allowedOrigins:ReadonlySet<string>;allowLoopback?:boolean;method?:string;headers?:Record<string,string>;body?:Uint8Array;maxBytes?:number;timeout?:number}){
 const parsed=new URL(url),loopback=options.allowLoopback&&['localhost','127.0.0.1'].includes(parsed.hostname);
 if(!options.allowedOrigins.has(parsed.origin)||parsed.username||parsed.password||parsed.hash||!(parsed.protocol==='https:'||loopback&&parsed.protocol==='http:'))throw new DomainError('profile_origin_not_allowed',403);
 const timeout=options.timeout??5000;
 const addresses=await new Promise<Array<{address:string;family:number}>>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new DomainError('profile_dns_timeout',502)),timeout);
  lookup(parsed.hostname,{all:true,verbatim:true}).then(resolve,reject).finally(()=>clearTimeout(timer));
 });
 if(!addresses.length||!loopback&&addresses.some(address=>!publicAddress(address.address)))throw new DomainError('profile_address_not_allowed',403);
 const address=addresses.find(value=>value.family===4)??addresses[0];
 return await new Promise<{status:number;headers:Record<string,string>;body:Buffer}>((resolve,reject)=>{
  const send=parsed.protocol==='https:'?httpsRequest:httpRequest;
  const request=send(parsed,{method:options.method??'GET',headers:{Accept:'application/json','Accept-Encoding':'identity',...options.headers},family:address.family,lookup:(_hostname,_options,callback)=>callback(null,address.address,address.family)},response=>{
   const status=response.statusCode??0;
   if(status>=300&&status<400){response.destroy();reject(new DomainError('profile_redirect_forbidden',502));return;}
   const chunks:Buffer[]=[];let size=0;
   response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>(options.maxBytes??262144)){reject(new DomainError('profile_too_large',502));response.destroy();request.destroy();return;}chunks.push(chunk);});
   response.on('error',reject);
   response.on('end',()=>resolve({status,headers:Object.fromEntries(Object.entries(response.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):String(v)])),body:Buffer.concat(chunks)}));
  });
  request.on('error',reject);request.setTimeout(timeout,()=>{reject(new DomainError('profile_request_timeout',502));request.destroy();});
  if(options.body)request.write(options.body);request.end();
 });
}
