import {createHash,createPublicKey,verify as verifySignature} from 'node:crypto';
import {httpbis,type Request,type Response} from 'http-message-signatures';
import {parseDictionary,serializeDictionary,isInnerList} from 'structured-headers';
import type {JWK} from 'jose';
import {DomainError} from '@yours/domain';
import type {DetachedSigner} from './index.js';

type Message=Request|Response;
const normalized=(headers:Record<string,string|string[]>)=>Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),Array.isArray(v)?v.join(', '):v]));
export const contentDigest=(body:Uint8Array)=>'sha-256=:'+createHash('sha256').update(body).digest('base64')+':';
function required(message:Message,body:Uint8Array){
 const headers=normalized(message.headers);
 const fields='method' in message?['@method','@authority','@path']:['@status'];
 if('url' in message&&new URL(message.url).search)fields.push('@query');
 for(const name of ['ucp-agent','idempotency-key','webhook-id','webhook-timestamp','etag'])if(headers[name])fields.push(name);
 if(body.length)fields.push('content-digest','content-type');
 return fields;
}
/** UCP REST signatures use raw-body SHA-256 and IEEE P1363 ES256. */
export async function signHttp<T extends Message>(message:T,body:Uint8Array,signer:DetachedSigner):Promise<T>{
 const headers=normalized(message.headers);
 if(body.length){headers['content-digest']=contentDigest(body);headers['content-type']??='application/json';}
 const input={...message,headers};
 const config={name:'ucp',fields:required(input,body),key:{id:signer.kid,alg:'ecdsa-p256-sha256',sign:async(bytes:Buffer)=>Buffer.from(await signer.sign(bytes))}};
 const signed='method' in input?await httpbis.signMessage(config,input as Request):await httpbis.signMessage(config,input as Response);
 return {...signed,headers:normalized(signed.headers)} as T;
}
/** Each signature is evaluated independently: a bad countersignature cannot
 * hide a valid one. Key lookup uses only the enrolled profile, never jku/jwk. */
export async function verifyHttp(message:Message,body:Uint8Array,keys:JWK[]):Promise<string>{
 const headers=normalized(message.headers);
 if(body.length&&headers['content-digest']!==contentDigest(body))throw new DomainError('digest_mismatch',401);
 if((headers['signature-input']?.length??0)>8192||(headers.signature?.length??0)>8192)throw new DomainError('signature_invalid',401);
 try{
  const inputs=parseDictionary(headers['signature-input']??''),signatures=parseDictionary(headers.signature??'');
  if(inputs.size>8)throw new Error('too_many_signatures');
  const fields=required(message,body);
  for(const [label,input] of inputs){
   try{
    if(!isInnerList(input)||!signatures.has(label))continue;
    // Required components must cover the whole field. Merely signing a
    // dictionary member of Content-Digest would not bind its sha-256 entry.
    if(fields.some(field=>!input[0].some(([name,params])=>name===field&&params.size===0)))continue;
    if(input[0].length>24)continue;
    const kid=input[1].get('keyid'),alg=input[1].get('alg');
    if(typeof kid!=='string'||(alg!==undefined&&!['ES256','ecdsa-p256-sha256'].includes(String(alg))))continue;
    const matching=keys.filter(key=>key.kid===kid&&key.kty==='EC'&&key.crv==='P-256'&&!key.d&&(!key.use||key.use==='sig')&&(!key.key_ops||key.key_ops.includes('verify'))&&(!key.alg||key.alg==='ES256'));
    if(matching.length!==1)continue;
    const key=createPublicKey({key:matching[0],format:'jwk'});
    const one={...message,headers:{...headers,'signature-input':serializeDictionary(new Map([[label,input]])),signature:serializeDictionary(new Map([[label,signatures.get(label)!]]))}};
    const config={maxAge:300,tolerance:30,requiredFields:fields,keyLookup:async()=>({id:kid,algs:['ES256','ecdsa-p256-sha256'],verify:async(data:Buffer,signature:Buffer)=>signature.length===64&&verifySignature('sha256',data,{key,dsaEncoding:'ieee-p1363'},signature)})};
    if(await ('method' in one?httpbis.verifyMessage(config,one as Request):httpbis.verifyMessage(config,one as Response)))return kid;
   }catch{continue;}
  }
 }catch{throw new DomainError('signature_invalid',401);}
 throw new DomainError('signature_invalid',401);
}
