import {randomUUID,randomBytes} from 'node:crypto';
import {Hono} from 'hono';
import {z} from 'zod';
import {DomainError} from '@yours/domain';
import {idempotent,type Db,type Tx} from '@yours/storage';
import {profile,negotiate,signHttp,verifyHttp,parseAgentHeader,fetchProfile,authorizeCheckout,validateSchema,validateRequest,UCP_VERSION,AP2_CAPABILITY,HANDLER,type Entity} from '@yours/ucp';
import type {P256Signer} from '@yours/signing';
import type {Config} from './config.js';
import {authenticate,type Env} from './auth.js';
import {paymentRoutes} from './payments.js';
import {merchants,syncEcCatalog} from './merchants.js';

type MerchantEnv=Env&{Variables:Env['Variables']&{platform:string;capabilities:Record<string,Entity[]>}};
type LineInput={id?:string;item:{id:string;quantity_unit?:{unit:string;scale?:number}};quantity:number};
const lineSchema=z.object({id:z.string().optional(),item:z.object({id:z.string().min(1).max(256),quantity_unit:z.object({unit:z.string(),scale:z.number().int().optional()}).passthrough().optional()}).passthrough(),quantity:z.number().int().min(1).max(10000)}).passthrough();
const requestSchema=z.object({line_items:z.array(lineSchema).min(1).max(50),buyer:z.record(z.unknown()).optional(),context:z.record(z.unknown()).optional(),fulfillment:z.record(z.unknown()).optional()}).passthrough();
function actorId(c:any):string{const actor=c.get('actor');return actor.kind==='agent'?'agent:'+actor.connectionId:'owner:'+actor.accountId;}
function ucp(capabilities:Record<string,Entity[]>,checkout=false){return {version:UCP_VERSION,status:'success',capabilities,...(checkout?{payment_handlers:{[HANDLER]:[{id:'yours-stablecoin',version:UCP_VERSION}]}}:{})};}
function product(row:any,origin:string,lookup=false,merchant?:any){
 const price={amount:Number(row.amount_minor),currency:row.currency};if(!Number.isSafeInteger(price.amount))throw new Error('price_overflow');
 const description={plain:row.description};
 return {id:row.id,title:row.title,description,url:origin+'/market/'+encodeURIComponent(row.id),price_range:{min:price,max:price},
  variants:[{id:row.id,title:row.title,description,price,availability:{available:row.stock>0,status:row.stock>0?'in_stock':'out_of_stock'},...(lookup?{inputs:[{id:row.id,match:'exact'}]}:{})}],
  metadata:{requires_shipping:row.requires_shipping,merchant_id:row.merchant_id,merchant_name:merchant?.name??row.merchant_id,external:merchant?.adapter==='jpyc-ec'}};
}
async function priceLines(tx:Tx,merchantId:string,input:LineInput[],sessionId:string,reserve:boolean,expires:Date){
 const ids=input.map(l=>l.item.id);
 if(new Set(ids).size!==ids.length)throw new DomainError('duplicate_line_item',422);
 const {rows}=await tx.query('SELECT * FROM merchant_products WHERE merchant_id=$1 AND id=ANY($2) AND active=true ORDER BY id FOR UPDATE',[merchantId,ids]);
 if(rows.length!==ids.length)throw new DomainError('product_not_found',404);
 let subtotal=0;let shipping=false;
 const lines=[];
 for(let i=0;i<input.length;i++){
  const requested=input[i],row=rows.find(p=>p.id===requested.item.id)!;
  if(row.currency!=='JPY')throw new DomainError('currency_unsupported',422);
  const unit=requested.item.quantity_unit;
  if(unit&&(unit.unit!=='C62'||(unit.scale??0)!==0))throw new DomainError('quantity_unit_mismatch',422);
  const {rows:[held]}=await tx.query(`SELECT COALESCE(sum(r.quantity),0)::int AS quantity FROM inventory_reservations r JOIN merchant_sessions s ON s.id=r.session_id WHERE r.merchant_id=$1 AND r.product_id=$2 AND r.session_id<>$3 AND r.released_at IS NULL AND (r.expires_at>now() OR s.status='complete_in_progress')`,[merchantId,row.id,sessionId]);
  if(row.stock-held.quantity<requested.quantity)throw new DomainError('out_of_stock',409);
  const price=Number(row.amount_minor),amount=price*requested.quantity;
  if(!Number.isSafeInteger(amount)||!Number.isSafeInteger(subtotal+amount))throw new DomainError('amount_overflow',422);
  subtotal+=amount;shipping ||= row.requires_shipping;
  lines.push({id:requested.id??'line-'+(i+1),item:{id:row.id,title:row.title,price,...(row.image_url?{image_url:row.image_url}:{})},quantity:requested.quantity,totals:[{type:'subtotal',amount},{type:'total',amount}]});
 }
 if(reserve){
  await tx.query('UPDATE inventory_reservations SET released_at=now() WHERE session_id=$1',[sessionId]);
  for(const line of lines)await tx.query(`INSERT INTO inventory_reservations(session_id,merchant_id,product_id,quantity,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(session_id,product_id) DO UPDATE SET quantity=excluded.quantity,expires_at=excluded.expires_at,released_at=NULL`,[sessionId,merchantId,line.item.id,line.quantity,expires]);
 }
 return {lines,subtotal,shipping};
}
export function merchantRoutes(db:Db,config:Config,signer:P256Signer){
 const router=new Hono<MerchantEnv>();
 const directory=merchants(config),merchantIds=directory.map(m=>m.id);
 const catalogProduct=(row:any,lookup=false)=>product(row,config.PUBLIC_ORIGIN,lookup,directory.find(m=>m.id===row.merchant_id));
 const localProfile=()=>profile(config.PUBLIC_ORIGIN,'business',[signer.publicJwk]);
 router.use('*',async(c,next)=>{
  const platform=parseAgentHeader(c.req.header('UCP-Agent'));
  let remote;
  if(platform===config.PUBLIC_ORIGIN+'/.well-known/ucp'||platform===config.PUBLIC_ORIGIN+'/profiles/platform')remote=profile(config.PUBLIC_ORIGIN,'platform',[signer.publicJwk]);
  else remote=await fetchProfile(platform,new Set(config.TRUSTED_PROFILE_ORIGINS.split(',').filter(Boolean)),config.NODE_ENV!=='production');
  c.set('platform',platform);c.set('capabilities',negotiate(localProfile(),remote));
  if(c.req.header('Signature-Input')||c.req.header('Signature'))await verifyHttp({method:c.req.method,url:config.PUBLIC_ORIGIN+new URL(c.req.url).pathname+new URL(c.req.url).search,headers:Object.fromEntries(c.req.raw.headers)},new Uint8Array(await c.req.raw.clone().arrayBuffer()),remote.keys);
  if(!c.req.path.includes('/catalog/')){
   const actor=await authenticate(c,db,config);c.set('actor',actor);
   const row=actor.kind==='agent'?(await db.query('SELECT platform_profile FROM connections WHERE id=$1',[actor.connectionId])).rows[0]:null;
   const allowed=row?.platform_profile?[row.platform_profile]:[config.PUBLIC_ORIGIN+'/.well-known/ucp',config.PUBLIC_ORIGIN+'/profiles/platform'];
   if(!allowed.includes(platform))throw new DomainError('profile_identity_mismatch',403);
  }
  await next();
  if(c.res.status<400&&c.req.path.includes('/checkout-sessions')){
   const signed=await signHttp({status:c.res.status,headers:Object.fromEntries(c.res.headers)},new Uint8Array(await c.res.clone().arrayBuffer()),signer);
   for(const header of ['signature','signature-input','content-digest'])c.header(header,String(signed.headers[header]));
  }
 });
 router.post('/catalog/search',async c=>{
  const body=await c.req.json();validateSchema('shopping/catalog_search.json#/$defs/search_request',body);
  const request=z.object({query:z.string().max(256).default(''),pagination:z.object({limit:z.number().int().positive().optional(),cursor:z.string().max(1024).optional()}).optional(),filters:z.record(z.unknown()).optional()}).passthrough().parse(body);
  if(request.filters&&Object.keys(request.filters).length)throw new DomainError('filter_unsupported',422);
  await syncEcCatalog(db,config);
  const limit=Math.min(request.pagination?.limit??10,50);
  let cursor='';if(request.pagination?.cursor){try{cursor=Buffer.from(request.pagination.cursor,'base64url').toString('utf8');}catch{throw new DomainError('invalid_cursor',422);}}
  const escaped=request.query.replace(/[\\%_]/g,'\\$&');
  const {rows}=await db.query("SELECT * FROM merchant_products WHERE merchant_id=ANY($1) AND active=true AND id>$2 AND (title ILIKE $3 OR description ILIKE $3) ORDER BY id LIMIT $4",[merchantIds,cursor,'%'+escaped+'%',limit+1]);
  const hasNext=rows.length>limit;const selected=rows.slice(0,limit);
  const response={ucp:ucp(c.get('capabilities')),products:selected.map(r=>catalogProduct(r)),pagination:{has_next_page:hasNext,...(hasNext?{cursor:Buffer.from(selected.at(-1)!.id).toString('base64url')}:{})}};
  validateSchema('shopping/catalog_search.json#/$defs/search_response',response);return c.json(response);
 });
 router.post('/catalog/lookup',async c=>{
  const body=await c.req.json();validateSchema('shopping/catalog_lookup.json#/$defs/lookup_request',body);
  const request=z.object({ids:z.array(z.string().min(1).max(256)).min(1).max(100)}).passthrough().parse(body);
  await syncEcCatalog(db,config);
  const {rows}=await db.query('SELECT * FROM merchant_products WHERE merchant_id=ANY($1) AND id=ANY($2) AND active=true ORDER BY id',[merchantIds,request.ids]);
  const response={ucp:ucp(c.get('capabilities')),products:rows.map(r=>catalogProduct(r,true))};
  validateSchema('shopping/catalog_lookup.json#/$defs/lookup_response',response);return c.json(response);
 });
 router.post('/catalog/product',async c=>{
  const body=await c.req.json();validateSchema('shopping/catalog_lookup.json#/$defs/get_product_request',body);
  const request=z.object({id:z.string().min(1).max(256),selected:z.array(z.unknown()).optional(),filters:z.record(z.unknown()).optional()}).passthrough().parse(body);
  if(request.selected?.length||request.filters&&Object.keys(request.filters).length)throw new DomainError('product_option_unsupported',422);
  await syncEcCatalog(db,config);
  const {rows:[row]}=await db.query('SELECT * FROM merchant_products WHERE merchant_id=ANY($1) AND id=$2 AND active=true',[merchantIds,request.id]);if(!row)throw new DomainError('product_not_found',404);
  const response={ucp:ucp(c.get('capabilities')),product:catalogProduct(row)};validateSchema('shopping/catalog_lookup.json#/$defs/get_product_response',response);return c.json(response);
 });
 for(const [path,kind] of [['/carts','cart'],['/checkout-sessions','checkout']] as const){
  const respond=(c:any,result:any)=>{c.header('ETag','"'+result.yours.revision+'"');return c.json(result);};
  router.post(path,async c=>{
   const body=await c.req.json();const actor=actorId(c);
   const response=await idempotent(db,actor+':create:'+kind,c.req.header('Idempotency-Key')??'',body,async tx=>{
    let input=body;
    if(kind==='checkout'&&typeof body.cart_id==='string'){
     const {rows:[cart]}=await tx.query("SELECT * FROM merchant_sessions WHERE id=$1 AND kind='cart' AND actor=$2 AND platform_profile=$3 AND expires_at>now() AND status<>'canceled' FOR UPDATE",[z.string().uuid().parse(body.cart_id),actor,c.get('platform')]);
     if(!cart)throw new DomainError('cart_not_found',404);
     input={line_items:cart.document.line_items.map((l:any)=>({item:{id:l.item.id},quantity:l.quantity})),...(cart.document.buyer?{buyer:cart.document.buyer}:{}),...(cart.document.context?{context:cart.document.context}:{})};
    }
    validateRequest(kind,'create',input);const request=requestSchema.parse(input);
    const id=randomUUID(),expires=new Date(Date.now()+30*60*1000);
    // Insert the parent first; stock holds and the document are committed together.
    await tx.query('INSERT INTO merchant_sessions(id,merchant_id,kind,actor,platform_profile,ap2_required,status,document,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,config.MERCHANT_ID,kind,actor,c.get('platform'),Boolean(c.get('capabilities')[AP2_CAPABILITY]),'incomplete','{}',expires]);
    const priced=await priceLines(tx,config.MERCHANT_ID,request.line_items,id,kind==='checkout',expires);
    const document=await makeDocument(id,kind,request,priced,1,expires,c.get('capabilities'),config,signer);
    await tx.query('UPDATE merchant_sessions SET status=$2,document=$3 WHERE id=$1',[id,document.status??'active',JSON.stringify(document)]);
    return {status:201,body:document};
   });
   c.header('ETag','"'+response.body.yours.revision+'"');return c.json(response.body,response.status as 201);
  });
  router.get(path+'/:id',async c=>{
   const row=await session(db,c.req.param('id'),actorId(c),c.get('platform'),kind);
   if(kind==='checkout'&&!row.document.ap2)row.document.ap2={merchant_authorization:await authorizeCheckout(row.document,signer)};
   return respond(c,row.document);
  });
  router.put(path+'/:id',async c=>{
   const body=await c.req.json();validateRequest(kind,'update',body);const request=requestSchema.parse(body);
   const id=z.string().uuid().parse(c.req.param('id')),actor=actorId(c);
   const result=await idempotent(db,actor+':update:'+id,c.req.header('Idempotency-Key')??'',{body,etag:c.req.header('If-Match')??null},async tx=>{
    const row=await session(tx,id,actor,c.get('platform'),kind,true);
    if(row.merchant_id!==config.MERCHANT_ID)throw new DomainError('ec_checkout_immutable',409);
    if(!['incomplete','ready_for_complete','active'].includes(row.status))throw new DomainError('session_not_editable',409);
    if(new Date(row.expires_at).getTime()<=Date.now())throw new DomainError('session_expired',409);
    if(c.req.header('If-Match')!=='"'+row.revision+'"')throw new DomainError('revision_conflict',412);
    const priced=await priceLines(tx,config.MERCHANT_ID,request.line_items,id,kind==='checkout',row.expires_at);
    const document=await makeDocument(id,kind,request,priced,row.revision+1,row.expires_at,c.get('capabilities'),config,signer);
    await tx.query('UPDATE merchant_sessions SET document=$2,status=$3,revision=revision+1,updated_at=now() WHERE id=$1',[id,JSON.stringify(document),document.status??'active']);
    return {status:200,body:document};
   });return respond(c,result.body);
  });
  router.post(path+'/:id/cancel',async c=>{
   const id=z.string().uuid().parse(c.req.param('id')),actor=actorId(c);
   const result=await idempotent(db,actor+':cancel:'+id,c.req.header('Idempotency-Key')??'',{},async tx=>{
    const row=await session(tx,id,actor,c.get('platform'),kind,true);
    if(['complete_in_progress','completed'].includes(row.status))throw new DomainError('payment_in_progress_or_complete',409);
    if(row.status==='canceled')return {status:200,body:row.document};
    const document={...row.document,...(kind==='checkout'?{status:'canceled'}:{}),yours:{...row.document.yours,status:'canceled',revision:row.revision+1}};
    delete document.ap2;
    if(kind==='checkout')document.ap2={merchant_authorization:await authorizeCheckout(document,signer)};
    await tx.query("UPDATE merchant_sessions SET document=$2,status='canceled',revision=revision+1,updated_at=now() WHERE id=$1",[id,JSON.stringify(document)]);
    await tx.query('UPDATE inventory_reservations SET released_at=now() WHERE session_id=$1',[id]);
    return {status:200,body:document};
   });return respond(c,result.body);
  });
 }
 paymentRoutes(router,db,config,signer);
 router.get('/orders/:id',async c=>{
  const {rows:[row]}=await db.query('SELECT o.document FROM merchant_orders o JOIN merchant_sessions s ON s.id=o.session_id WHERE o.id=$1 AND s.actor=$2 AND s.platform_profile=$3',[z.string().uuid().parse(c.req.param('id')),actorId(c),c.get('platform')]);
  if(!row)throw new DomainError('order_not_found',404);
  validateSchema('shopping/order.json',row.document);return c.json(row.document);
 });
 return router;
}
export async function session(db:Pick<Db,'query'>|Tx,id:unknown,actor:string,platform:string,kind:'cart'|'checkout',lock=false){
 const {rows:[row]}=await db.query('SELECT * FROM merchant_sessions WHERE id=$1 AND actor=$2 AND platform_profile=$3 AND kind=$4'+(lock?' FOR UPDATE':''),[z.string().uuid().parse(id),actor,platform,kind]);
 if(!row)throw new DomainError('session_not_found',404);return row;
}
export async function makeDocument(id:string,kind:'cart'|'checkout',request:any,priced:any,revision:number,expires:Date,capabilities:Record<string,Entity[]>,config:Config,signer:P256Signer){
 let incomplete=priced.shipping;
 const document:any={ucp:ucp(capabilities,kind==='checkout'),id,line_items:priced.lines,currency:'JPY',totals:[{type:'subtotal',amount:priced.subtotal},{type:'total',amount:priced.subtotal}],
 links:[{type:'privacy_policy',url:config.PUBLIC_ORIGIN+'/privacy'},{type:'terms_of_service',url:config.PUBLIC_ORIGIN+'/terms'}],expires_at:expires.toISOString(),
 continue_url:config.PUBLIC_ORIGIN+'/checkout/'+id,merchant:{id:config.MERCHANT_ID,name:config.MERCHANT_NAME},
 yours:{revision,network:'eip155:'+config.CHAIN_ID,...(config.JPYC_ADDRESS?{asset:config.JPYC_ADDRESS}:{}),...(config.MERCHANT_PAY_TO?{pay_to:config.MERCHANT_PAY_TO}:{}),nonce:randomBytes(24).toString('base64url'),audience:config.PUBLIC_ORIGIN},
 ...(request.buyer?{buyer:request.buyer}:{}),...(request.context?{context:request.context}:{})};
 if(kind==='checkout'){
  if(priced.shipping&&capabilities['dev.ucp.shopping.fulfillment']){
   const method=request.fulfillment?.methods?.[0];
   if(request.fulfillment&&(request.fulfillment.methods?.length!==1||method?.type!=='shipping'))throw new DomainError('fulfillment_method_unsupported',422);
   const destinations=(method?.destinations??[]).map((address:any,index:number)=>{
    const allowed=['id','type','extended_address','street_address','address_locality','address_region','address_country','postal_code','first_name','last_name','phone_number'];
    const value:any=Object.fromEntries(Object.entries(address).filter(([key])=>allowed.includes(key)));
    value.id=address.id??'destination-'+index;value.type='shipping_address';validateSchema('shopping/types/shipping_destination.json',value);return value;
   });
   const selected=method?.selected_destination_id??(destinations.length===1?destinations[0].id:null);
   const address=destinations.find((d:any)=>d.id===selected);
   const valid=address&&address.address_country==='JP'&&['street_address','address_locality','address_region','postal_code'].every(key=>typeof address[key]==='string'&&address[key].trim().length>0);
   const option=method?.groups?.find((g:any)=>g.id==='shipping-group')?.selected_option_id??null;
   if(option&&option!=='standard')throw new DomainError('shipping_option_invalid',422);
   incomplete=!valid||option!=='standard';
   const lineIds=priced.lines.map((line:any)=>line.id);
   document.fulfillment={methods:[{id:'shipping',type:'shipping',line_item_ids:lineIds,destinations,selected_destination_id:selected,groups:[{id:'shipping-group',line_item_ids:lineIds,options:[{id:'standard',title:'通常配送',totals:[{type:'fulfillment',amount:350},{type:'total',amount:350}]}],selected_option_id:option}]}]};
   if(!incomplete)document.totals=[{type:'subtotal',amount:priced.subtotal},{type:'fulfillment',display_text:'通常配送',amount:350},{type:'total',amount:priced.subtotal+350}];
  }
  document.status=incomplete?'incomplete':'ready_for_complete';
  if(incomplete)document.messages=[{type:'error',code:'missing_shipping_address',content:'配送先を指定してください。',severity:'recoverable',path:'$.fulfillment'}];
  validateSchema('shopping/checkout.json',document);
  if(document.fulfillment)validateSchema('shopping/fulfillment.json#/$defs/dev.ucp.shopping.checkout',document);
  document.ap2={merchant_authorization:await authorizeCheckout(document,signer)};
 }else validateSchema('shopping/cart.json',document);
 return document;
}
