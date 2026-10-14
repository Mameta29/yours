import {GoogleAuth} from 'google-auth-library';
import {DomainError} from '@yours/domain';
import type {Config} from './config.js';

const auth=new GoogleAuth();
/** Destinations are operator configuration, never an agent-supplied URL. */
export async function internalPost<T>(config:Config,origin:string|undefined,path:string,body:unknown):Promise<T>{
 if(!origin)throw new DomainError('service_not_configured',503);
 const url=new URL(origin);
 if(url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('invalid_internal_origin');
 const headers:Record<string,string>={'Content-Type':'application/json'};
 if(config.NODE_ENV==='production'){
  if(url.protocol!=='https:')throw new Error('internal_https_required');
  const client=await auth.getIdTokenClient(url.origin);
  headers.Authorization='Bearer '+await client.idTokenProvider.fetchIdToken(url.origin);
 }else if(!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('local_internal_service_required');
 const response=await fetch(url.origin+path,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok){
  const status=response.status===403?403:response.status===409?409:response.status===422?422:502;
  throw new DomainError('authority_service_rejected',status);
 }
 return await response.json() as T;
}
