import {readFile} from 'node:fs/promises';
import {createPublicClient,http,keccak256,getAddress,parseAbi,type Address,type Hex,type PublicClient} from 'viem';
import {polygonAmoy,foundry} from 'viem/chains';
import {yoursPurchaseGateAbi,agentPermissionRegistryAbi,type Enforcers} from '@yours/wallet-sdk';
import {DomainError} from '@yours/domain';
import type {Config} from './config.js';

export interface ChainManifest {
 chainId:number;gate:Address;registry:Address;manager:Address;accountImplementation:Address;jpyc:Address;usdc:Address;
 enforcers:Enforcers;addresses:Record<'relayer'|'merchant'|'risk'|'human'|'price'|'agent',Address>;
 contracts:Array<{address:Address;codeHash:Hex}>;
 proxyImplementations?:Array<{proxy:Address;slot:Hex;implementation:Address;codeHash:Hex}>;
}
export interface ChainRuntime {
 manifest:ChainManifest;client:PublicClient;
 gate:{address:Address;abi:typeof yoursPurchaseGateAbi};
 registry:{address:Address;abi:typeof agentPermissionRegistryAbi};
}
export function chainRuntime(config:Config,manifest:ChainManifest):ChainRuntime{
 if(manifest.chainId!==config.CHAIN_ID)throw new Error('manifest_chain_mismatch');
 const client=createPublicClient({chain:config.CHAIN_ID===80002?polygonAmoy:foundry,transport:http(config.RPC_URL,{timeout:10000,retryCount:1})});
 return {manifest,client,gate:{address:manifest.gate,abi:yoursPurchaseGateAbi},registry:{address:manifest.registry,abi:agentPermissionRegistryAbi}};
}
export async function loadChain(config:Config):Promise<ChainRuntime|undefined>{
 let raw:string;
 try{raw=await readFile(config.CHAIN_MANIFEST_PATH,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 const manifest=JSON.parse(raw) as ChainManifest;
 const chain=chainRuntime(config,manifest);
 if(await chain.client.getChainId()!==manifest.chainId)throw new Error('rpc_chain_mismatch');
 for(const field of ['gate','registry','manager','accountImplementation','jpyc','usdc'] as const)getAddress(manifest[field]);
 for(const pin of manifest.contracts){
  const code=await chain.client.getCode({address:pin.address});
  if(!code||keccak256(code)!==pin.codeHash)throw new Error('deployment_code_mismatch');
 }
 for(const pin of manifest.proxyImplementations??[]){
  const slot=await chain.client.getStorageAt({address:pin.proxy,slot:pin.slot});
  if(!slot||getAddress('0x'+slot.slice(-40))!==getAddress(pin.implementation))throw new Error('deployment_proxy_changed');
  const code=await chain.client.getCode({address:pin.implementation});
  if(!code||keccak256(code)!==pin.codeHash)throw new Error('deployment_implementation_changed');
 }
 if(config.GATE_ADDRESS&&getAddress(config.GATE_ADDRESS)!==getAddress(manifest.gate))throw new Error('configured_gate_mismatch');
 return chain;
}
export async function confirmedCall(chain:ChainRuntime,hash:Hex,to:Address,data:Hex){
 const [receipt,tx,height]=await Promise.all([chain.client.getTransactionReceipt({hash}),chain.client.getTransaction({hash}),chain.client.getBlockNumber({cacheTime:0})]);
 if(receipt.status!=='success'||receipt.to?.toLowerCase()!==to.toLowerCase()||tx.input.toLowerCase()!==data.toLowerCase()||tx.chainId!==chain.manifest.chainId)throw new DomainError('activation_transaction_mismatch',422);
 if(height-receipt.blockNumber+1n<5n)throw new DomainError('activation_confirming',409);
 if((await chain.client.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash)throw new DomainError('activation_reorg',409);
 return receipt;
}
export const tokenAbi=parseAbi(['function balanceOf(address) view returns(uint256)','function decimals() view returns(uint8)']);
export const jsonSafe=<T>(value:T):any=>JSON.parse(JSON.stringify(value,(_key,value)=>typeof value==='bigint'?value.toString():value));
