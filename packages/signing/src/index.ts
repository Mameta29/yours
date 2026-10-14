import {createPublicKey,verify as cryptoVerify,createPrivateKey,generateKeyPairSync,sign as cryptoSign} from 'node:crypto';
import {readFile,open,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {KeyManagementServiceClient} from '@google-cloud/kms';
import {toAccount,publicKeyToAddress} from 'viem/accounts';
import {hashMessage,hashTypedData,keccak256,serializeTransaction,recoverAddress,toHex,hexToBytes,type Hex,type Address,type Signature,type SerializeTransactionFn} from 'viem';

const N=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** Strict ASN.1 DER decoder. Never truncates a malformed integer. */
export function decodeDerSignature(bytes:Uint8Array):{r:bigint;s:bigint}{
 let i=0;
 if(bytes[i++]!==0x30||bytes[i++]!==bytes.length-2)throw new Error('invalid_der');
 function integer(){
  if(bytes[i++]!==0x02)throw new Error('invalid_der');
  const length=bytes[i++];if(length<1||length>33||i+length>bytes.length)throw new Error('invalid_der');
  const value=bytes.slice(i,i+length);i+=length;
  if(value[0]&0x80||(length>1&&value[0]===0&&!(value[1]&0x80)))throw new Error('invalid_der');
  const n=BigInt('0x'+Buffer.from(value).toString('hex'));
  if(n===0n)throw new Error('invalid_der');return n;
 }
 const r=integer(),s=integer();if(i!==bytes.length)throw new Error('invalid_der');return {r,s};
}
export async function evmSignature(digest:Hex,der:Uint8Array,expectedAddress:Address):Promise<Signature>{
 const parsed=decodeDerSignature(der);
 if(parsed.r>=N||parsed.s>=N)throw new Error('invalid_secp256k1_signature');
 const r=toHex(parsed.r,{size:32}),s=toHex(parsed.s>N/2n?N-parsed.s:parsed.s,{size:32});
 for(const yParity of [0,1] as const){
  const signature={r,s,yParity};
  try{if((await recoverAddress({hash:digest,signature})).toLowerCase()===expectedAddress.toLowerCase())return signature;}catch{}
 }
 throw new Error('kms_signature_key_mismatch');
}
export function crc32c(value:Uint8Array):number{
 let crc=0xffffffff;for(const byte of value){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0x82f63b78:0);}return (crc^0xffffffff)>>>0;
}
export class KmsEvmSigner {
 private constructor(private client:KeyManagementServiceClient,readonly keyVersion:string,readonly address:Address){}
 static async create(keyVersion:string,client=new KeyManagementServiceClient()){
  const [key]=await client.getPublicKey({name:keyVersion});
  if(key.algorithm!=='EC_SIGN_SECP256K1_SHA256'&&key.algorithm!==31)throw new Error('wrong_evm_key_algorithm');
  if(!key.pem)throw new Error('kms_public_key_missing');
  const jwk=createPublicKey(key.pem).export({format:'jwk'});
  if(jwk.crv!=='secp256k1'||!jwk.x||!jwk.y)throw new Error('invalid_evm_public_key');
  const publicKey=toHex(Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]));
  return new KmsEvmSigner(client,keyVersion,publicKeyToAddress(publicKey));
 }
 async signHash(hash:Hex):Promise<Signature>{
  const bytes=hexToBytes(hash);if(bytes.length!==32)throw new Error('digest_length');
  // KMS accepts a 32-byte precomputed digest in this field. EVM uses Keccak;
  // do not SHA-256 it again. The returned ECDSA signature is recovered locally.
  const [response]=await this.client.asymmetricSign({name:this.keyVersion,digest:{sha256:bytes},digestCrc32c:{value:crc32c(bytes)}});
  const raw=response.signature;
  if(!raw||!response.verifiedDigestCrc32c)throw new Error('kms_digest_integrity');
  const signature=typeof raw==='string'?Buffer.from(raw,'base64'):raw;
  if(Number(response.signatureCrc32c?.value)!==crc32c(signature))throw new Error('kms_signature_integrity');
  return evmSignature(hash,signature,this.address);
 }
 account(){
  const signer=this;
  return toAccount({
   address:this.address,
   async signMessage({message}){const sig=await signer.signHash(hashMessage(message));return signatureHex(sig);},
   async signTypedData(data){return signatureHex(await signer.signHash(hashTypedData(data)));},
   async signTransaction(transaction,options){const serialize=(options?.serializer??serializeTransaction) as SerializeTransactionFn;const unsigned=await serialize(transaction);return serialize(transaction,await signer.signHash(keccak256(unsigned)));},
  });
 }
}
function signatureHex(sig:Signature):Hex{
 return (sig.r+sig.s.slice(2)+(27+Number(sig.yParity)).toString(16)) as Hex;
}
export interface P256Signer{kid:string;publicJwk:JsonWebKey&{kid:string;alg:string;use:string};sign(input:Uint8Array):Promise<Uint8Array>}
export async function localP256Signer(path:string,kid:string):Promise<P256Signer>{
 if(process.env.NODE_ENV==='production')throw new Error('local_keys_forbidden_in_production');
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 try{
  const handle=await open(path,'wx',0o600);
  try{const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});await handle.writeFile(privateKey.export({format:'pem',type:'pkcs8'}));}finally{await handle.close();}
 }catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 const key=createPrivateKey(await readFile(path));
 const publicJwk={...createPublicKey(key).export({format:'jwk'}),kid,alg:'ES256',use:'sig'};
 return {kid,publicJwk,sign:async input=>new Uint8Array(cryptoSign('sha256',input,{key,dsaEncoding:'ieee-p1363'}))};
}
export async function kmsP256Signer(keyVersion:string,kid:string):Promise<P256Signer>{
 const client=new KeyManagementServiceClient();const [key]=await client.getPublicKey({name:keyVersion});
 if(key.algorithm!=='EC_SIGN_P256_SHA256'&&key.algorithm!==12)throw new Error('wrong_ap2_key_algorithm');
 if(!key.pem)throw new Error('kms_public_key_missing');const publicKey=createPublicKey(key.pem);
 const publicJwk={...publicKey.export({format:'jwk'}),kid,alg:'ES256',use:'sig'};
 return {kid,publicJwk,async sign(input){
  const [response]=await client.asymmetricSign({name:keyVersion,data:input,dataCrc32c:{value:crc32c(input)}});
  const raw=response.signature;if(!raw||!response.verifiedDataCrc32c)throw new Error('kms_data_integrity');
  const der=typeof raw==='string'?Buffer.from(raw,'base64'):raw;
  if(Number(response.signatureCrc32c?.value)!==crc32c(der)||!cryptoVerify('sha256',input,publicKey,der))throw new Error('kms_signature_integrity');
  const {r,s}=decodeDerSignature(der);return hexToBytes((toHex(r,{size:32})+toHex(s,{size:32}).slice(2)) as Hex);
 }};
}
