import {canonicalJson,DomainError} from '@yours/domain';
import {base64url,compactVerify,decodeProtectedHeader,importJWK,type JWK} from 'jose';
import {validateSchema} from './schema.js';
export * from './schema.js';
export const UCP_VERSION='2026-08-25';
export const AP2_CAPABILITY='dev.ucp.common.payment.ap2_mandate';
export const HANDLER='io.github.mameta29.yours.stablecoin';
export const CHECKOUT='dev.ucp.shopping.checkout';
export const CAPABILITIES={
 [CHECKOUT]:'shopping/checkout.json',
 'dev.ucp.shopping.cart':'shopping/cart.json',
 'dev.ucp.shopping.catalog.search':'shopping/catalog_search.json',
 'dev.ucp.shopping.catalog.lookup':'shopping/catalog_lookup.json',
 'dev.ucp.shopping.order':'shopping/order.json',
 [AP2_CAPABILITY]:'common/payment_ap2_mandate.json',
} as const;
export interface Entity {version:string;id?:string;spec?:string;schema?:string;transport?:string;endpoint?:string;extends?:string|string[];config?:Record<string,unknown>}
export interface Profile {
 ucp:{version:string;services:Record<string,Entity[]>;capabilities:Record<string,Entity[]>;payment_handlers:Record<string,Entity[]>};
 keys:JWK[];
}
export function profile(origin:string,role:'business'|'platform',keys:JWK[],handlerConfig:Record<string,unknown>={}):Profile{
 const capabilities=Object.fromEntries(Object.entries(CAPABILITIES).map(([name,path])=>[name,[{version:UCP_VERSION,spec:'https://ucp.dev/specification/'+path.replace('.json','/'),schema:'https://ucp.dev/schemas/'+path,...(name===AP2_CAPABILITY?{extends:CHECKOUT}:{}),...(name==='dev.ucp.shopping.order'&&role==='platform'?{config:{webhook_url:origin+'/api/webhooks/orders'}}:{})}]]));
 const result:Profile={ucp:{version:UCP_VERSION,services:{'dev.ucp.shopping':[{version:UCP_VERSION,spec:'https://ucp.dev/specification/overview/',schema:'https://ucp.dev/services/shopping/rest.openapi.json',transport:'rest',endpoint:origin+'/ucp'}]},capabilities,payment_handlers:{[HANDLER]:[{id:'yours-stablecoin',version:UCP_VERSION,spec:origin+'/payment-handler',schema:origin+'/schemas/stablecoin-handler.json',config:handlerConfig}]}},keys};
 validateSchema('profile.json#/$defs/'+role+'_schema',result);return result;
}
export function negotiate(business:Profile,platform:Profile,{requireAp2=true}={}):Record<string,Entity[]>{
 validateSchema('profile.json#/$defs/business_schema',business);validateSchema('profile.json#/$defs/platform_schema',platform);
 if(business.ucp.version!==UCP_VERSION||platform.ucp.version!==UCP_VERSION)throw new DomainError('version_unsupported',400);
 const common:Record<string,Entity[]>={};
 for(const [name,entries] of Object.entries(business.ucp.capabilities??{})){
  const entry=entries.find(e=>e.version===UCP_VERSION&&(platform.ucp.capabilities[name]??[]).some(p=>p.version===e.version));
  if(entry)common[name]=[{version:entry.version,...(entry.extends?{extends:entry.extends}:{})}];
 }
 for(const [name,[entry]] of Object.entries(common)){
  const parents=entry.extends?(Array.isArray(entry.extends)?entry.extends:[entry.extends]):[];
  if(parents.length&&!parents.some(p=>common[p]))delete common[name];
 }
 if(!common[CHECKOUT])throw new DomainError('checkout_not_supported',400);
 if(requireAp2&&!common[AP2_CAPABILITY])throw new DomainError('mandate_required',400);
 return common;
}
export function parseAgentHeader(header:string|undefined):string{
 if(!header||header.length>2048)throw new DomainError('ucp_agent_required',400);
 const matches=[...header.matchAll(/(?:^|,)\s*profile="([^"\\]+)"/g)];
 if(matches.length!==1)throw new DomainError('ucp_agent_invalid',400);
 const url=new URL(matches[0][1]);if(url.hash||url.username||url.password)throw new DomainError('ucp_agent_invalid',400);
 return url.href;
}
/** Only operator-enrolled HTTPS origins. Redirects are never followed. */
export async function fetchProfile(url:string,allowedOrigins:ReadonlySet<string>,allowLoopback=false):Promise<Profile>{
 const parsed=new URL(url);
 if(!allowedOrigins.has(parsed.origin)||parsed.username||parsed.password||parsed.hash||!(parsed.protocol==='https:'||(allowLoopback&&parsed.protocol==='http:'&&['localhost','127.0.0.1'].includes(parsed.hostname))))throw new DomainError('profile_origin_not_allowed',403);
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Accept:'application/json'}});
 if(!response.ok||!(response.headers.get('content-type')??'').includes('application/json'))throw new DomainError('profile_unavailable',502);
 const reader=response.body?.getReader();if(!reader)throw new DomainError('profile_unavailable',502);
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144)throw new DomainError('profile_too_large',502);chunks.push(value);}}finally{await reader.cancel();}
 const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 validateSchema('profile.json',result);return result as Profile;
}
export interface DetachedSigner {kid:string;sign(input:Uint8Array):Promise<Uint8Array>}
export function checkoutPayload(checkout:Record<string,unknown>):string{
 const {ap2:_,...payload}=checkout;return canonicalJson(payload);
}
export async function authorizeCheckout(checkout:Record<string,unknown>,signer:DetachedSigner):Promise<string>{
 const header=base64url.encode(JSON.stringify({alg:'ES256',kid:signer.kid}));
 const payload=base64url.encode(checkoutPayload(checkout));
 const signature=await signer.sign(new TextEncoder().encode(header+'.'+payload));
 if(signature.length!==64)throw new Error('ES256 requires an IEEE P1363 signature');
 return header+'..'+base64url.encode(signature);
}
export async function verifyCheckout(checkout:Record<string,unknown>,keys:JWK[]):Promise<string>{
 const ap2=checkout.ap2 as {merchant_authorization?:string}|undefined;
 const detached=ap2?.merchant_authorization;if(!detached)throw new DomainError('merchant_authorization_missing',422);
 const segments=detached.split('.');if(segments.length!==3||segments[1]!=='')throw new DomainError('merchant_authorization_invalid',422);
 try{
  const header=decodeProtectedHeader(detached);
  if(header.alg!=='ES256'||!header.kid||header.jwk||header.jku)throw new Error('invalid_header');
  const matching=keys.filter(k=>k.kid===header.kid);
  if(matching.length!==1||matching[0].d||matching[0].kty!=='EC'||matching[0].crv!=='P-256')throw new Error('invalid_key');
  const jwt=segments[0]+'.'+base64url.encode(checkoutPayload(checkout))+'.'+segments[2];
  await compactVerify(jwt,await importJWK(matching[0],'ES256'),{algorithms:['ES256']});
  return jwt;
 }catch{throw new DomainError('merchant_authorization_invalid',422);}
}
