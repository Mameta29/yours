import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Ajv2020} from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {DomainError} from '@yours/domain';
type Schema=Record<string,any>;
const directory=fileURLToPath(new URL('../vendor/ucp-2026-08-25/source/schemas/',import.meta.url));
const ajv=new Ajv2020({strict:false,allErrors:true,validateFormats:true});
(addFormats as unknown as (instance:Ajv2020)=>void)(ajv);
const schemas=new Map<string,Schema>();
function walk(dir:string){
 for(const file of readdirSync(dir,{withFileTypes:true})){
  if(file.isDirectory())walk(dir+file.name+'/');
  else if(file.name.endsWith('.json')){
   const schema=JSON.parse(readFileSync(dir+file.name,'utf8'));if(schema.$id){schemas.set(schema.$id,schema);ajv.addSchema(schema);}
  }
 }
}
walk(directory);
export function validateSchema(ref:string,value:unknown):void{
 const full=ref.startsWith('https://')?ref:'https://ucp.dev/schemas/'+ref;
 const validate=ajv.getSchema(full)??ajv.compile({$ref:full});
 if(!validate(value))throw new DomainError('ucp_schema_invalid',422,{schema:full,errors:validate.errors});
}
/** Derive request shapes from the pinned ucp_request annotations, retaining refs. */
function transform(node:any,operation:'create'|'update'|'complete'):any {
 if(node===null||typeof node!=='object')return node;
 const out:Schema={};
 for(const [k,v] of Object.entries(node)){
  if(k==='ucp_request')continue;
  if((k==='$id'||k==='$ref')&&typeof v==='string')out[k]=v.replace('https://ucp.dev/','https://schemas.yours.invalid/'+operation+'/');
  else if(['properties','$defs','definitions','patternProperties','dependentSchemas'].includes(k))out[k]=Object.fromEntries(Object.entries(v as Schema).map(([name,child])=>[name,transform(child,operation)]));
  else if(['allOf','anyOf','oneOf','prefixItems'].includes(k))out[k]=(v as any[]).map(child=>transform(child,operation));
  else if(['items','additionalProperties','unevaluatedProperties','contains','propertyNames','if','then','else','not'].includes(k))out[k]=transform(v,operation);
  else out[k]=v;
 }
 if(node.properties){
  const required=new Set<string>(node.required??[]);
  for(const [name,property] of Object.entries(node.properties) as [string,Schema][]){
   const annotation=property.ucp_request;
   const rule=typeof annotation==='string'?annotation:annotation?.[operation];
   if(rule==='omit'){out.properties[name]=false;required.delete(name);}
   else if(rule==='optional')required.delete(name);
   else if(rule==='required')required.add(name);
  }
  out.required=[...required];
 }
 return out;
}
const derived=new Set<string>();
export function validateRequest(resource:'checkout'|'cart',operation:'create'|'update'|'complete',value:unknown):void{
 if(!derived.has(operation)){for(const schema of schemas.values())ajv.addSchema(transform(schema,operation));derived.add(operation);}
 validateSchema('https://schemas.yours.invalid/'+operation+'/schemas/shopping/'+resource+'.json',value);
}
export function schemaDocument(path:string):Schema|undefined{return schemas.get('https://ucp.dev/schemas/'+path);}
